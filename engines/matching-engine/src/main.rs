mod decimal;

use chrono::{SecondsFormat, Utc};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::env;
use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{Arc, Mutex};
use std::thread;

const PROTOCOL_VERSION: &str = "v2";

#[derive(Clone, PartialEq, Deserialize)]
#[serde(rename_all = "lowercase")]
enum Side {
    Buy,
    Sell,
}

#[derive(Clone, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
enum OrderType {
    Limit,
    Market,
}

#[derive(Clone, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
enum TimeInForce {
    Gtc,
    Ioc,
    Fok,
}

#[derive(Clone)]
struct RestingOrder {
    order_id: String,
    side: Side,
    /// Fixed-point price in atomic units (see `decimal`).
    price: i128,
    /// Price as originally received; echoed back verbatim in trades/snapshots.
    price_text: String,
    /// Remaining resting quantity in atomic units.
    quantity: i128,
    /// Text form of `quantity`: the original input for untouched seeds,
    /// otherwise the canonical `decimal::format` output.
    quantity_text: String,
    created_at: String,
}

#[derive(Clone, Default)]
struct OrderBook {
    bids: Vec<RestingOrder>,
    asks: Vec<RestingOrder>,
}

#[derive(Clone)]
struct MarketState {
    book: OrderBook,
    next_execution_sequence: u64,
    next_batch_sequence: u64,
}

impl Default for MarketState {
    fn default() -> Self {
        Self {
            book: OrderBook::default(),
            next_execution_sequence: 1,
            next_batch_sequence: 1,
        }
    }
}

type SharedBooks = Arc<Mutex<HashMap<String, MarketState>>>;

#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "snake_case")]
enum Command {
    Submit {
        order_id: String,
        market: String,
        side: Side,
        order_type: OrderType,
        time_in_force: TimeInForce,
        price: Option<String>,
        quantity: String,
        created_at: String,
    },
    Seed {
        order_id: String,
        market: String,
        side: Side,
        price: String,
        quantity: String,
        created_at: String,
    },
    Cancel {
        order_id: String,
        market: String,
    },
    Reset {
        market: String,
        /// Also restart sequences at 1. Only for a full demo reset that wiped
        /// every persisted trade and stream; book replays must leave it off.
        #[serde(default)]
        reset_sequences: bool,
    },
    /// Raises the market's sequence counters after a restart so new trades
    /// never reuse an execution id the order-service already persisted.
    Restore {
        market: String,
        next_execution_sequence: u64,
        next_batch_sequence: u64,
    },
    Snapshot {
        market: String,
        limit: Option<usize>,
    },
}

fn main() {
    let host = env::var("MATCHING_ENGINE_HOST").unwrap_or_else(|_| "127.0.0.1".to_string());
    let port = env::var("PORT").unwrap_or_else(|_| "3011".to_string());
    let listener = TcpListener::bind(format!("{host}:{port}"))
        .unwrap_or_else(|error| panic!("failed to bind matching engine: {error}"));
    let books: SharedBooks = Arc::new(Mutex::new(HashMap::new()));

    println!("matching-engine listening on {host}:{port}");

    for stream in listener.incoming() {
        match stream {
            Ok(stream) => {
                let books = Arc::clone(&books);
                thread::spawn(move || {
                    if let Err(error) = handle_stream(stream, books) {
                        eprintln!("matching-engine request failed: {error}");
                    }
                });
            }
            Err(error) => {
                eprintln!("matching-engine accept error: {error}");
            }
        }
    }
}

fn handle_stream(mut stream: TcpStream, books: SharedBooks) -> Result<(), String> {
    let mut command = String::new();
    let mut reader = BufReader::new(
        stream
            .try_clone()
            .map_err(|error| format!("clone stream failed: {error}"))?,
    );
    reader
        .read_line(&mut command)
        .map_err(|error| format!("read command failed: {error}"))?;

    let response = process_command(command.trim(), books);
    stream
        .write_all(format!("{}\n", response.to_string()).as_bytes())
        .map_err(|error| format!("write response failed: {error}"))?;
    stream
        .flush()
        .map_err(|error| format!("flush response failed: {error}"))?;

    Ok(())
}

fn process_command(command: &str, books: SharedBooks) -> Value {
    process_command_with_clock(command, books, &now_iso)
}

/// Same as `process_command`, but with an injectable clock for `executedAt`
/// so replay tests can compare full responses byte for byte.
fn process_command_with_clock(command: &str, books: SharedBooks, clock: &dyn Fn() -> String) -> Value {
    let parsed = serde_json::from_str::<Command>(command);
    match parsed {
        Ok(Command::Submit {
            order_id,
            market,
            side,
            order_type,
            time_in_force,
            price,
            quantity,
            created_at,
        }) => submit_order(
            &order_id,
            &market,
            side,
            order_type,
            time_in_force,
            price,
            &quantity,
            &created_at,
            books,
            clock,
        ),
        Ok(Command::Seed {
            order_id,
            market,
            side,
            price,
            quantity,
            created_at,
        }) => seed_order(&order_id, &market, side, &price, &quantity, &created_at, books),
        Ok(Command::Cancel { order_id, market }) => cancel_order(&order_id, &market, books),
        Ok(Command::Reset {
            market,
            reset_sequences,
        }) => reset_book(&market, reset_sequences, books),
        Ok(Command::Restore {
            market,
            next_execution_sequence,
            next_batch_sequence,
        }) => restore_sequences(&market, next_execution_sequence, next_batch_sequence, books),
        Ok(Command::Snapshot { market, limit }) => snapshot_book(&market, limit.unwrap_or(50), books),
        Err(error) => error_json("INVALID_COMMAND", &format!("invalid command payload: {error}")),
    }
}

fn submit_order(
    order_id: &str,
    market: &str,
    side: Side,
    order_type: OrderType,
    time_in_force: TimeInForce,
    price_text: Option<String>,
    quantity_text: &str,
    created_at: &str,
    books: SharedBooks,
    clock: &dyn Fn() -> String,
) -> Value {
    let quantity = match parse_quantity(quantity_text) {
        Ok(quantity) => quantity,
        Err(error) => return error,
    };

    let parsed_price = match (&order_type, &price_text) {
        (_, Some(price)) => match parse_price(price) {
            Ok(parsed) => Some((parsed, price.clone())),
            Err(error) => return error,
        },
        (OrderType::Limit, None) => return error_json("PRICE_REQUIRED", "limit order price is required"),
        (OrderType::Market, None) => None,
    };

    let mut books = match books.lock() {
        Ok(books) => books,
        Err(_) => return error_json("BOOK_LOCK_POISONED", "matching-engine book lock poisoned"),
    };
    let state = books.entry(market.to_string()).or_insert_with(MarketState::default);
    let execution_batch_id = format!("{market}:{}", state.next_batch_sequence);
    state.next_batch_sequence += 1;
    let mut next_execution_sequence = state.next_execution_sequence;
    let mut taker_remaining = quantity;
    let mut trades = Vec::new();
    let taker_price = parsed_price.as_ref().map(|value| value.0);

    {
        let book = &mut state.book;

        sort_book(book);

        let executable_quantity = if side == Side::Buy {
            sum_executable_quantity(&book.asks, &side, &order_type, taker_price)
        } else {
            sum_executable_quantity(&book.bids, &side, &order_type, taker_price)
        };

        if time_in_force == TimeInForce::Fok {
            if executable_quantity == 0 {
                return cancelled_response(order_id, "fok_liquidity_not_found");
            }

            if executable_quantity < quantity {
                return cancelled_response(order_id, "fok_quantity_not_met");
            }
        }

        let opposite = if side == Side::Buy {
            &mut book.asks
        } else {
            &mut book.bids
        };

        while taker_remaining > 0 {
            let Some(best_resting) = opposite.first().cloned() else {
                break;
            };

            if !crosses(&side, &order_type, taker_price, best_resting.price) {
                break;
            }

            opposite.remove(0);

            // Exact integer arithmetic: both remainders are >= 0 and one of
            // them is exactly 0 after every fill.
            let fill_quantity = best_resting.quantity.min(taker_remaining);
            taker_remaining -= fill_quantity;
            let maker_remaining = best_resting.quantity - fill_quantity;

            if maker_remaining > 0 {
                let mut updated = best_resting.clone();
                updated.quantity = maker_remaining;
                updated.quantity_text = decimal::format(maker_remaining);
                opposite.push(updated);

                if side == Side::Buy {
                    sort_asks(opposite);
                } else {
                    sort_bids(opposite);
                }
            }

            let execution_batch_sequence = trades.len() as u64 + 1;
            let execution_sequence = next_execution_sequence;
            next_execution_sequence += 1;
            let execution_id = format!("{execution_batch_id}:{execution_batch_sequence}");

            trades.push(json!({
                "makerOrderId": best_resting.order_id,
                "takerOrderId": order_id,
                "price": best_resting.price_text,
                "quantity": decimal::format(fill_quantity),
                "executedAt": clock(),
                "executionId": execution_id,
                "executionBatchId": execution_batch_id.clone(),
                "executionSequence": execution_sequence,
                "executionBatchSequence": execution_batch_sequence,
                "replayCursor": format!("{market}:{execution_sequence}"),
                "protocolVersion": PROTOCOL_VERSION,
                "makerCreatedAt": best_resting.created_at,
                "takerCreatedAt": created_at,
                "makerRemainingQuantity": decimal::format(maker_remaining)
            }));
        }

        if trades.is_empty() {
            if order_type == OrderType::Limit && time_in_force == TimeInForce::Gtc {
                let Some((price, normalized_price_text)) = parsed_price else {
                    return error_json("PRICE_REQUIRED", "resting order price is required");
                };
                insert_resting(
                    book,
                    RestingOrder {
                        order_id: order_id.to_string(),
                        side,
                        price,
                        price_text: normalized_price_text,
                        quantity,
                        quantity_text: decimal::format(quantity),
                        created_at: created_at.to_string(),
                    },
                );
                return json!({
                    "outcome": "resting",
                    "orderId": order_id,
                    "protocolVersion": PROTOCOL_VERSION,
                    "trades": []
                });
            }

            return cancelled_response(order_id, "no_executable_liquidity");
        }

        let taker_status = if taker_remaining == 0 {
            "filled"
        } else if order_type == OrderType::Limit && time_in_force == TimeInForce::Gtc {
            let Some((price, normalized_price_text)) = parsed_price else {
                return error_json("PRICE_REQUIRED", "resting order price is required");
            };
            insert_resting(
                book,
                RestingOrder {
                    order_id: order_id.to_string(),
                    side,
                    price,
                    price_text: normalized_price_text,
                    quantity: taker_remaining,
                    quantity_text: decimal::format(taker_remaining),
                    created_at: created_at.to_string(),
                },
            );
            "resting"
        } else {
            "cancelled"
        };

        state.next_execution_sequence = next_execution_sequence;

        return json!({
            "outcome": "matched",
            "orderId": order_id,
            "takerStatus": taker_status,
            "takerRemainingQuantity": decimal::format(if taker_status == "resting" { taker_remaining } else { 0 }),
            "protocolVersion": PROTOCOL_VERSION,
            "trades": trades
        });
    }
}

fn seed_order(
    order_id: &str,
    market: &str,
    side: Side,
    price_text: &str,
    quantity_text: &str,
    created_at: &str,
    books: SharedBooks,
) -> Value {
    let price = match parse_price(price_text) {
        Ok(price) => price,
        Err(error) => return error,
    };
    let quantity = match parse_quantity(quantity_text) {
        Ok(quantity) => quantity,
        Err(error) => return error,
    };

    let mut books = match books.lock() {
        Ok(books) => books,
        Err(_) => return error_json("BOOK_LOCK_POISONED", "matching-engine book lock poisoned"),
    };
    let state = books.entry(market.to_string()).or_insert_with(MarketState::default);
    let book = &mut state.book;
    insert_resting(
        book,
        RestingOrder {
            order_id: order_id.to_string(),
            side,
            price,
            price_text: price_text.to_string(),
            quantity,
            quantity_text: quantity_text.to_string(),
            created_at: created_at.to_string(),
        },
    );

    json!({
        "outcome": "seeded",
        "orderId": order_id
    })
}

fn cancel_order(order_id: &str, market: &str, books: SharedBooks) -> Value {
    let mut books = match books.lock() {
        Ok(books) => books,
        Err(_) => return error_json("BOOK_LOCK_POISONED", "matching-engine book lock poisoned"),
    };
    let Some(state) = books.get_mut(market) else {
        return json!({
            "outcome": "not_found",
            "orderId": order_id
        });
    };
    let book = &mut state.book;

    if let Some(index) = book.bids.iter().position(|order| order.order_id == order_id) {
        let removed = book.bids.remove(index);
        // The quantity actually taken off the book: callers release only the
        // funds backing this remainder, never funds of already matched fills.
        return json!({
            "outcome": "cancelled",
            "orderId": order_id,
            "cancelledQuantity": removed.quantity_text
        });
    }

    if let Some(index) = book.asks.iter().position(|order| order.order_id == order_id) {
        let removed = book.asks.remove(index);
        // The quantity actually taken off the book: callers release only the
        // funds backing this remainder, never funds of already matched fills.
        return json!({
            "outcome": "cancelled",
            "orderId": order_id,
            "cancelledQuantity": removed.quantity_text
        });
    }

    json!({
        "outcome": "not_found",
        "orderId": order_id
    })
}

fn reset_book(market: &str, reset_sequences: bool, books: SharedBooks) -> Value {
    let mut books = match books.lock() {
        Ok(books) => books,
        Err(_) => return error_json("BOOK_LOCK_POISONED", "matching-engine book lock poisoned"),
    };
    // Only the book is cleared: execution / batch sequences keep counting so a
    // replayed book can never produce an execution id that already exists.
    let state = books.entry(market.to_string()).or_default();
    if reset_sequences {
        *state = MarketState::default();
    } else {
        state.book = OrderBook::default();
    }
    json!({
        "outcome": "reset",
        "market": market,
        "nextExecutionSequence": state.next_execution_sequence,
        "nextBatchSequence": state.next_batch_sequence
    })
}

fn restore_sequences(
    market: &str,
    next_execution_sequence: u64,
    next_batch_sequence: u64,
    books: SharedBooks,
) -> Value {
    let mut books = match books.lock() {
        Ok(books) => books,
        Err(_) => return error_json("BOOK_LOCK_POISONED", "matching-engine book lock poisoned"),
    };
    let state = books.entry(market.to_string()).or_default();
    // Never move backwards: a stale restore must not reopen used sequence numbers.
    state.next_execution_sequence = state.next_execution_sequence.max(next_execution_sequence);
    state.next_batch_sequence = state.next_batch_sequence.max(next_batch_sequence);
    json!({
        "outcome": "restored",
        "market": market,
        "nextExecutionSequence": state.next_execution_sequence,
        "nextBatchSequence": state.next_batch_sequence
    })
}

fn snapshot_book(market: &str, limit: usize, books: SharedBooks) -> Value {
    let books = match books.lock() {
        Ok(books) => books,
        Err(_) => return error_json("BOOK_LOCK_POISONED", "matching-engine book lock poisoned"),
    };
    let state = books.get(market).cloned().unwrap_or_default();
    let book = state.book;

    json!({
        "outcome": "snapshot",
        "market": market,
        "nextExecutionSequence": state.next_execution_sequence,
        "nextBatchSequence": state.next_batch_sequence,
        "bids": book.bids.into_iter().take(limit).map(to_snapshot_order).collect::<Vec<Value>>(),
        "asks": book.asks.into_iter().take(limit).map(to_snapshot_order).collect::<Vec<Value>>()
    })
}

fn to_snapshot_order(order: RestingOrder) -> Value {
    json!({
        "orderId": order.order_id,
        "side": match order.side {
            Side::Buy => "buy",
            Side::Sell => "sell",
        },
        "price": order.price_text,
        "quantity": order.quantity_text,
        "createdAt": order.created_at
    })
}

fn insert_resting(book: &mut OrderBook, order: RestingOrder) {
    if order.side == Side::Buy {
        book.bids.push(order);
        sort_bids(&mut book.bids);
    } else {
        book.asks.push(order);
        sort_asks(&mut book.asks);
    }
}

fn sort_book(book: &mut OrderBook) {
    sort_bids(&mut book.bids);
    sort_asks(&mut book.asks);
}

fn sort_bids(bids: &mut Vec<RestingOrder>) {
    bids.sort_by(|left, right| {
        right
            .price
            .cmp(&left.price)
            .then_with(|| left.created_at.cmp(&right.created_at))
    });
}

fn sort_asks(asks: &mut Vec<RestingOrder>) {
    asks.sort_by(|left, right| {
        left
            .price
            .cmp(&right.price)
            .then_with(|| left.created_at.cmp(&right.created_at))
    });
}

fn crosses(side: &Side, order_type: &OrderType, taker_price: Option<i128>, maker_price: i128) -> bool {
    if *order_type == OrderType::Market {
        return true;
    }

    match (side, taker_price) {
        (Side::Buy, Some(price)) => maker_price <= price,
        (Side::Sell, Some(price)) => maker_price >= price,
        _ => false,
    }
}

fn sum_executable_quantity(
    orders: &Vec<RestingOrder>,
    side: &Side,
    order_type: &OrderType,
    taker_price: Option<i128>,
) -> i128 {
    let mut total: i128 = 0;
    for order in orders {
        if !crosses(side, order_type, taker_price, order.price) {
            break;
        }
        // Saturate instead of overflowing; FOK only needs to know whether the
        // total reaches the taker quantity.
        total = total.saturating_add(order.quantity);
    }
    total
}

fn cancelled_response(order_id: &str, reason: &str) -> Value {
    json!({
        "outcome": "cancelled",
        "orderId": order_id,
        "takerStatus": "cancelled",
        "takerRemainingQuantity": "0",
        "protocolVersion": PROTOCOL_VERSION,
        "reason": reason
    })
}

fn error_json(code: &str, message: &str) -> Value {
    json!({
        "error": {
            "code": code,
            "message": message
        }
    })
}

fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn parse_price(text: &str) -> Result<i128, Value> {
    match decimal::parse(text) {
        Ok(0) | Err(decimal::DecimalError::Negative) => Err(error_json("INVALID_PRICE", "price must be positive")),
        Ok(price) => Ok(price),
        Err(error) => Err(error_json("INVALID_PRICE", &format!("invalid price: {error}"))),
    }
}

fn parse_quantity(text: &str) -> Result<i128, Value> {
    match decimal::parse(text) {
        Ok(0) | Err(decimal::DecimalError::Negative) => Err(error_json("INVALID_QUANTITY", "quantity must be positive")),
        Ok(quantity) => Ok(quantity),
        Err(error) => Err(error_json("INVALID_QUANTITY", &format!("invalid quantity: {error}"))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    struct ReplayRegressionCase {
        name: &'static str,
        commands: Vec<Value>,
        expected: Vec<Value>,
    }

    fn shared_books() -> SharedBooks {
        Arc::new(Mutex::new(HashMap::new()))
    }

    fn command(value: Value, books: &SharedBooks) -> Value {
        process_command(&value.to_string(), Arc::clone(books))
    }

    fn normalize_matched_response(response: &Value) -> Value {
        let trades = response["trades"]
            .as_array()
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .map(|trade| {
                json!({
                    "makerOrderId": trade["makerOrderId"],
                    "takerOrderId": trade["takerOrderId"],
                    "price": trade["price"],
                    "quantity": trade["quantity"],
                    "executionId": trade["executionId"],
                    "executionBatchId": trade["executionBatchId"],
                    "executionSequence": trade["executionSequence"],
                    "executionBatchSequence": trade["executionBatchSequence"],
                    "replayCursor": trade["replayCursor"],
                    "protocolVersion": trade["protocolVersion"],
                    "makerRemainingQuantity": trade["makerRemainingQuantity"]
                })
            })
            .collect::<Vec<Value>>();

        json!({
            "outcome": response["outcome"],
            "orderId": response["orderId"],
            "takerStatus": response["takerStatus"],
            "takerRemainingQuantity": response["takerRemainingQuantity"],
            "protocolVersion": response["protocolVersion"],
            "trades": trades
        })
    }

    fn normalize_response(response: &Value) -> Value {
        match response["outcome"].as_str() {
            Some("matched") => normalize_matched_response(response),
            Some("snapshot") => json!({
                "outcome": response["outcome"],
                "market": response["market"],
                "bids": response["bids"],
                "asks": response["asks"]
            }),
            Some("cancelled") => json!({
                "outcome": response["outcome"],
                "orderId": response["orderId"],
                "takerStatus": response["takerStatus"],
                "takerRemainingQuantity": response["takerRemainingQuantity"],
                "protocolVersion": response["protocolVersion"],
                "reason": response["reason"],
                "trades": response["trades"]
            }),
            _ => response.clone(),
        }
    }

    #[test]
    fn deterministic_replay_is_stable_for_multi_level_sweeps() {
        let first_run_books = shared_books();
        let first_run = run_multi_level_sweep(&first_run_books);

        let replay_books = shared_books();
        let replay_run = run_multi_level_sweep(&replay_books);

        assert_eq!(
            normalize_matched_response(&first_run.0),
            normalize_matched_response(&replay_run.0)
        );
        assert_eq!(first_run.1, replay_run.1);
    }

    #[test]
    fn replay_regression_suite_covers_priority_and_time_in_force_paths() {
        let cases = vec![
            ReplayRegressionCase {
                name: "time_priority_same_price_matches_oldest_first",
                commands: vec![
                    json!({
                        "action": "seed",
                        "order_id": "sell-oldest",
                        "market": "BTC-USDT",
                        "side": "sell",
                        "price": "65000",
                        "quantity": "0.40",
                        "created_at": "2026-03-10T10:00:00.000Z"
                    }),
                    json!({
                        "action": "seed",
                        "order_id": "sell-newest",
                        "market": "BTC-USDT",
                        "side": "sell",
                        "price": "65000",
                        "quantity": "0.60",
                        "created_at": "2026-03-10T10:00:01.000Z"
                    }),
                    json!({
                        "action": "submit",
                        "order_id": "buy-priority",
                        "market": "BTC-USDT",
                        "side": "buy",
                        "order_type": "limit",
                        "time_in_force": "gtc",
                        "price": "65000",
                        "quantity": "0.70",
                        "created_at": "2026-03-10T10:00:02.000Z"
                    }),
                    json!({
                        "action": "snapshot",
                        "market": "BTC-USDT",
                        "limit": 10
                    })
                ],
                expected: vec![
                    json!({"outcome": "seeded", "orderId": "sell-oldest"}),
                    json!({"outcome": "seeded", "orderId": "sell-newest"}),
                    json!({
                        "outcome": "matched",
                        "orderId": "buy-priority",
                        "takerStatus": "filled",
                        "takerRemainingQuantity": "0",
                        "protocolVersion": PROTOCOL_VERSION,
                        "trades": [
                            {
                                "makerOrderId": "sell-oldest",
                                "takerOrderId": "buy-priority",
                                "price": "65000",
                                "quantity": "0.4",
                                "executionId": "BTC-USDT:1:1",
                                "executionBatchId": "BTC-USDT:1",
                                "executionSequence": 1,
                                "executionBatchSequence": 1,
                                "replayCursor": "BTC-USDT:1",
                                "protocolVersion": PROTOCOL_VERSION,
                                "makerRemainingQuantity": "0"
                            },
                            {
                                "makerOrderId": "sell-newest",
                                "takerOrderId": "buy-priority",
                                "price": "65000",
                                "quantity": "0.3",
                                "executionId": "BTC-USDT:1:2",
                                "executionBatchId": "BTC-USDT:1",
                                "executionSequence": 2,
                                "executionBatchSequence": 2,
                                "replayCursor": "BTC-USDT:2",
                                "protocolVersion": PROTOCOL_VERSION,
                                "makerRemainingQuantity": "0.3"
                            }
                        ]
                    }),
                    json!({
                        "outcome": "snapshot",
                        "market": "BTC-USDT",
                        "bids": [],
                        "asks": [{
                            "orderId": "sell-newest",
                            "side": "sell",
                            "price": "65000",
                            "quantity": "0.3",
                            "createdAt": "2026-03-10T10:00:01.000Z"
                        }]
                    })
                ]
            },
            ReplayRegressionCase {
                name: "ioc_partial_fill_cancels_remaining_quantity",
                commands: vec![
                    json!({
                        "action": "seed",
                        "order_id": "sell-ioc",
                        "market": "BTC-USDT",
                        "side": "sell",
                        "price": "65000",
                        "quantity": "0.40",
                        "created_at": "2026-03-10T10:10:00.000Z"
                    }),
                    json!({
                        "action": "submit",
                        "order_id": "buy-ioc",
                        "market": "BTC-USDT",
                        "side": "buy",
                        "order_type": "limit",
                        "time_in_force": "ioc",
                        "price": "65000",
                        "quantity": "0.60",
                        "created_at": "2026-03-10T10:10:01.000Z"
                    }),
                    json!({
                        "action": "snapshot",
                        "market": "BTC-USDT",
                        "limit": 10
                    })
                ],
                expected: vec![
                    json!({"outcome": "seeded", "orderId": "sell-ioc"}),
                    json!({
                        "outcome": "matched",
                        "orderId": "buy-ioc",
                        "takerStatus": "cancelled",
                        "takerRemainingQuantity": "0",
                        "protocolVersion": PROTOCOL_VERSION,
                        "trades": [{
                            "makerOrderId": "sell-ioc",
                            "takerOrderId": "buy-ioc",
                            "price": "65000",
                            "quantity": "0.4",
                            "executionId": "BTC-USDT:1:1",
                            "executionBatchId": "BTC-USDT:1",
                            "executionSequence": 1,
                            "executionBatchSequence": 1,
                            "replayCursor": "BTC-USDT:1",
                            "protocolVersion": PROTOCOL_VERSION,
                            "makerRemainingQuantity": "0"
                        }]
                    }),
                    json!({
                        "outcome": "snapshot",
                        "market": "BTC-USDT",
                        "bids": [],
                        "asks": []
                    })
                ]
            },
            ReplayRegressionCase {
                name: "fok_reject_does_not_mutate_book_state",
                commands: vec![
                    json!({
                        "action": "seed",
                        "order_id": "sell-fok",
                        "market": "BTC-USDT",
                        "side": "sell",
                        "price": "65000",
                        "quantity": "0.20",
                        "created_at": "2026-03-10T10:20:00.000Z"
                    }),
                    json!({
                        "action": "submit",
                        "order_id": "buy-fok",
                        "market": "BTC-USDT",
                        "side": "buy",
                        "order_type": "limit",
                        "time_in_force": "fok",
                        "price": "65000",
                        "quantity": "0.30",
                        "created_at": "2026-03-10T10:20:01.000Z"
                    }),
                    json!({
                        "action": "snapshot",
                        "market": "BTC-USDT",
                        "limit": 10
                    })
                ],
                expected: vec![
                    json!({"outcome": "seeded", "orderId": "sell-fok"}),
                    json!({
                        "outcome": "cancelled",
                        "orderId": "buy-fok",
                        "takerStatus": "cancelled",
                        "takerRemainingQuantity": "0",
                        "protocolVersion": PROTOCOL_VERSION,
                        "reason": "fok_quantity_not_met",
                        "trades": null
                    }),
                    json!({
                        "outcome": "snapshot",
                        "market": "BTC-USDT",
                        "bids": [],
                        "asks": [{
                            "orderId": "sell-fok",
                            "side": "sell",
                            "price": "65000",
                            "quantity": "0.20",
                            "createdAt": "2026-03-10T10:20:00.000Z"
                        }]
                    })
                ]
            }
        ];

        for case in cases {
            let books = shared_books();
            let actual = case
                .commands
                .iter()
                .map(|item| normalize_response(&command(item.clone(), &books)))
                .collect::<Vec<Value>>();

            assert_eq!(actual, case.expected, "regression case {}", case.name);
        }
    }

    #[test]
    fn execution_sequence_and_replay_cursor_progress_monotonically_across_batches() {
        let books = shared_books();

        command(
            json!({
                "action": "seed",
                "order_id": "sell-1",
                "market": "BTC-USDT",
                "side": "sell",
                "price": "65000",
                "quantity": "0.40",
                "created_at": "2026-03-10T10:00:00.000Z"
            }),
            &books,
        );
        command(
            json!({
                "action": "seed",
                "order_id": "sell-2",
                "market": "BTC-USDT",
                "side": "sell",
                "price": "65010",
                "quantity": "0.60",
                "created_at": "2026-03-10T10:00:01.000Z"
            }),
            &books,
        );

        let first_match = command(
            json!({
                "action": "submit",
                "order_id": "buy-1",
                "market": "BTC-USDT",
                "side": "buy",
                "order_type": "limit",
                "time_in_force": "gtc",
                "price": "65010",
                "quantity": "0.70",
                "created_at": "2026-03-10T10:00:02.000Z"
            }),
            &books,
        );
        let second_match = command(
            json!({
                "action": "submit",
                "order_id": "buy-2",
                "market": "BTC-USDT",
                "side": "buy",
                "order_type": "limit",
                "time_in_force": "gtc",
                "price": "65010",
                "quantity": "0.30",
                "created_at": "2026-03-10T10:00:03.000Z"
            }),
            &books,
        );

        let first_sequences = first_match["trades"]
            .as_array()
            .unwrap()
            .iter()
            .map(|trade| trade["executionSequence"].as_u64().unwrap())
            .collect::<Vec<u64>>();
        let second_sequences = second_match["trades"]
            .as_array()
            .unwrap()
            .iter()
            .map(|trade| trade["executionSequence"].as_u64().unwrap())
            .collect::<Vec<u64>>();
        let replay_cursors = second_match["trades"]
            .as_array()
            .unwrap()
            .iter()
            .map(|trade| trade["replayCursor"].as_str().unwrap().to_string())
            .collect::<Vec<String>>();

        assert_eq!(first_sequences, vec![1, 2]);
        assert_eq!(second_sequences, vec![3]);
        assert_eq!(replay_cursors, vec!["BTC-USDT:3".to_string()]);
        assert_eq!(first_match["trades"][0]["executionBatchId"], json!("BTC-USDT:1"));
        assert_eq!(second_match["trades"][0]["executionBatchId"], json!("BTC-USDT:2"));
    }

    fn run_multi_level_sweep(books: &SharedBooks) -> (Value, Value) {
        command(
            json!({
                "action": "seed",
                "order_id": "sell-a",
                "market": "BTC-USDT",
                "side": "sell",
                "price": "65000",
                "quantity": "0.40",
                "created_at": "2026-03-10T10:00:00.000Z"
            }),
            books,
        );
        command(
            json!({
                "action": "seed",
                "order_id": "sell-b",
                "market": "BTC-USDT",
                "side": "sell",
                "price": "65010",
                "quantity": "0.60",
                "created_at": "2026-03-10T10:00:01.000Z"
            }),
            books,
        );

        let matched = command(
            json!({
                "action": "submit",
                "order_id": "buy-a",
                "market": "BTC-USDT",
                "side": "buy",
                "order_type": "limit",
                "time_in_force": "gtc",
                "price": "65010",
                "quantity": "0.75",
                "created_at": "2026-03-10T10:00:02.000Z"
            }),
            books,
        );
        let snapshot = command(
            json!({
                "action": "snapshot",
                "market": "BTC-USDT",
                "limit": 10
            }),
            books,
        );

        (matched, snapshot)
    }

    fn fixed_clock() -> String {
        "2026-03-10T00:00:00.000Z".to_string()
    }

    fn run_with_fixed_clock(commands: &[Value]) -> Vec<String> {
        let books = shared_books();
        commands
            .iter()
            .map(|item| {
                process_command_with_clock(&item.to_string(), Arc::clone(&books), &fixed_clock).to_string()
            })
            .collect()
    }

    fn seed(order_id: &str, market: &str, side: &str, price: &str, quantity: &str, created_at: &str) -> Value {
        json!({
            "action": "seed",
            "order_id": order_id,
            "market": market,
            "side": side,
            "price": price,
            "quantity": quantity,
            "created_at": created_at
        })
    }

    fn submit(
        order_id: &str,
        market: &str,
        side: &str,
        order_type: &str,
        time_in_force: &str,
        price: Option<&str>,
        quantity: &str,
        created_at: &str,
    ) -> Value {
        let mut value = json!({
            "action": "submit",
            "order_id": order_id,
            "market": market,
            "side": side,
            "order_type": order_type,
            "time_in_force": time_in_force,
            "quantity": quantity,
            "created_at": created_at
        });
        if let Some(price) = price {
            value["price"] = json!(price);
        }
        value
    }

    fn mixed_replay_script() -> Vec<Value> {
        vec![
            seed("s1", "BTC-USDT", "sell", "65000", "0.1", "2026-03-10T10:00:00.000Z"),
            seed("s2", "BTC-USDT", "sell", "65000", "0.2", "2026-03-10T10:00:01.000Z"),
            seed("s3", "BTC-USDT", "sell", "65010.5", "0.35", "2026-03-10T10:00:02.000Z"),
            seed("s4", "BTC-USDT", "sell", "65020", "1", "2026-03-10T10:00:03.000Z"),
            seed("b1", "BTC-USDT", "buy", "64990", "0.5", "2026-03-10T10:00:04.000Z"),
            seed("b2", "BTC-USDT", "buy", "64980", "0.7", "2026-03-10T10:00:05.000Z"),
            seed("e1", "ETH-USDT", "sell", "3200", "1.5", "2026-03-10T10:00:06.000Z"),
            // FOK that cannot be met leaves the book untouched.
            submit("t-fok-miss", "BTC-USDT", "buy", "limit", "fok", Some("65000"), "0.31", "2026-03-10T10:01:00.000Z"),
            // Multi-level sweep with GTC remainder resting on the bid side.
            submit("t-gtc", "BTC-USDT", "buy", "limit", "gtc", Some("65010.5"), "0.7", "2026-03-10T10:01:01.000Z"),
            // IOC sell crosses the resting remainder and the best bid, rest cancelled.
            submit("t-ioc", "BTC-USDT", "sell", "limit", "ioc", Some("64990"), "0.9", "2026-03-10T10:01:02.000Z"),
            // Market buy partially consumes the last ask level.
            submit("t-mkt", "BTC-USDT", "buy", "market", "ioc", None, "0.25", "2026-03-10T10:01:03.000Z"),
            // FOK that is exactly met.
            submit("t-fok-hit", "BTC-USDT", "buy", "limit", "fok", Some("65020"), "0.75", "2026-03-10T10:01:04.000Z"),
            // A GTC order that rests without trading, then is cancelled.
            submit("t-rest", "ETH-USDT", "buy", "limit", "gtc", Some("3100"), "2.50", "2026-03-10T10:01:05.000Z"),
            json!({"action": "cancel", "order_id": "t-rest", "market": "ETH-USDT"}),
            // Partial fill of a seed, then cancel of its remainder.
            submit("t-eth", "ETH-USDT", "buy", "limit", "ioc", Some("3200"), "0.4", "2026-03-10T10:01:06.000Z"),
            json!({"action": "cancel", "order_id": "e1", "market": "ETH-USDT"}),
            json!({"action": "cancel", "order_id": "missing", "market": "ETH-USDT"}),
            // Rejected inputs.
            submit("t-bad-qty", "BTC-USDT", "buy", "limit", "gtc", Some("65000"), "0.1234567890123456789", "2026-03-10T10:01:07.000Z"),
            submit("t-bad-price", "BTC-USDT", "buy", "limit", "gtc", Some("abc"), "1", "2026-03-10T10:01:08.000Z"),
            json!({"action": "snapshot", "market": "BTC-USDT", "limit": 10}),
            json!({"action": "snapshot", "market": "ETH-USDT", "limit": 10}),
            json!({"action": "reset", "market": "BTC-USDT"}),
            json!({"action": "snapshot", "market": "BTC-USDT", "limit": 10}),
        ]
    }

    #[test]
    fn full_replay_produces_byte_identical_output() {
        let script = mixed_replay_script();
        let first = run_with_fixed_clock(&script);
        let second = run_with_fixed_clock(&script);

        assert_eq!(first.join("\n"), second.join("\n"));
        // The script exercises real trades, not just rejections.
        let matched = first.iter().filter(|line| line.contains("\"outcome\":\"matched\"")).count();
        assert_eq!(matched, 5);
    }

    #[test]
    fn mixed_replay_reports_exact_quantities() {
        let books = shared_books();
        let responses = mixed_replay_script()
            .iter()
            .map(|item| command(item.clone(), &books))
            .collect::<Vec<Value>>();
        // First response for `order_id` that is not the seed acknowledgement.
        let by_order = |order_id: &str| {
            responses
                .iter()
                .find(|response| response["orderId"] == json!(order_id) && response["outcome"] != json!("seeded"))
                .cloned()
                .unwrap()
        };

        assert_eq!(by_order("t-fok-miss")["reason"], json!("fok_quantity_not_met"));

        let gtc = by_order("t-gtc");
        assert_eq!(gtc["takerStatus"], json!("resting"));
        // 0.7 - 0.1 - 0.2 - 0.35 = 0.05 exactly.
        assert_eq!(gtc["takerRemainingQuantity"], json!("0.05"));
        let gtc_fills = gtc["trades"]
            .as_array()
            .unwrap()
            .iter()
            .map(|trade| (trade["price"].as_str().unwrap(), trade["quantity"].as_str().unwrap()))
            .collect::<Vec<_>>();
        assert_eq!(gtc_fills, vec![("65000", "0.1"), ("65000", "0.2"), ("65010.5", "0.35")]);

        let ioc = by_order("t-ioc");
        assert_eq!(ioc["takerStatus"], json!("cancelled"));
        let ioc_fills = ioc["trades"]
            .as_array()
            .unwrap()
            .iter()
            .map(|trade| (trade["makerOrderId"].as_str().unwrap(), trade["quantity"].as_str().unwrap()))
            .collect::<Vec<_>>();
        assert_eq!(ioc_fills, vec![("t-gtc", "0.05"), ("b1", "0.5")]);

        let market = by_order("t-mkt");
        assert_eq!(market["takerStatus"], json!("filled"));
        assert_eq!(market["trades"][0]["makerRemainingQuantity"], json!("0.75"));

        let fok = by_order("t-fok-hit");
        assert_eq!(fok["takerStatus"], json!("filled"));
        assert_eq!(fok["trades"][0]["makerRemainingQuantity"], json!("0"));

        // Untouched resting order is cancelled with its full remaining quantity.
        assert_eq!(by_order("t-rest")["outcome"], json!("resting"));
        let cancel_rest = responses
            .iter()
            .find(|response| response["orderId"] == json!("t-rest") && response["outcome"] == json!("cancelled"))
            .unwrap();
        assert_eq!(cancel_rest["cancelledQuantity"], json!("2.5"));
        // Partially filled seed reports only what was left on the book.
        let cancel_seed = by_order("e1");
        assert_eq!(cancel_seed["cancelledQuantity"], json!("1.1"));
        assert_eq!(by_order("missing")["outcome"], json!("not_found"));

        assert_eq!(responses[17]["error"]["code"], json!("INVALID_QUANTITY"));
        assert_eq!(responses[18]["error"]["code"], json!("INVALID_PRICE"));

        // Final ETH book is empty; BTC book was reset.
        assert_eq!(responses[20]["asks"], json!([]));
        assert_eq!(responses[20]["bids"], json!([]));
        assert_eq!(responses[22]["asks"], json!([]));
        assert_eq!(responses[22]["bids"], json!([]));
        // Before the reset only b2 is left on BTC bids, and s4 is gone.
        assert_eq!(responses[19]["bids"][0]["orderId"], json!("b2"));
        assert_eq!(responses[19]["asks"], json!([]));
    }

    #[test]
    fn taker_of_point_three_fully_consumes_point_one_and_point_two() {
        let books = shared_books();
        command(seed("m1", "BTC-USDT", "sell", "65000", "0.1", "2026-03-10T10:00:00.000Z"), &books);
        command(seed("m2", "BTC-USDT", "sell", "65000", "0.2", "2026-03-10T10:00:01.000Z"), &books);

        let response = command(
            submit("t", "BTC-USDT", "buy", "limit", "gtc", Some("65000"), "0.3", "2026-03-10T10:00:02.000Z"),
            &books,
        );

        assert_eq!(response["takerStatus"], json!("filled"));
        assert_eq!(response["takerRemainingQuantity"], json!("0"));
        assert_eq!(response["trades"][0]["quantity"], json!("0.1"));
        assert_eq!(response["trades"][1]["quantity"], json!("0.2"));
        assert_eq!(response["trades"][0]["makerRemainingQuantity"], json!("0"));
        assert_eq!(response["trades"][1]["makerRemainingQuantity"], json!("0"));

        let snapshot = command(json!({"action": "snapshot", "market": "BTC-USDT"}), &books);
        assert_eq!(snapshot["asks"], json!([]));
        assert_eq!(snapshot["bids"], json!([]), "no dust remainder may rest");
    }

    #[test]
    fn sweeping_three_makers_sums_exactly() {
        let books = shared_books();
        command(seed("m1", "BTC-USDT", "sell", "100", "0.1", "2026-03-10T10:00:00.000Z"), &books);
        command(seed("m2", "BTC-USDT", "sell", "101", "0.1", "2026-03-10T10:00:01.000Z"), &books);
        command(seed("m3", "BTC-USDT", "sell", "102", "0.1", "2026-03-10T10:00:02.000Z"), &books);
        command(seed("m4", "BTC-USDT", "sell", "103", "5", "2026-03-10T10:00:03.000Z"), &books);

        // In f64, 0.1 + 0.1 + 0.1 == 0.30000000000000004, so a 0.3 taker
        // would leave dust on the third maker. With fixed point it is exact.
        let response = command(
            submit("t", "BTC-USDT", "buy", "market", "ioc", None, "0.3", "2026-03-10T10:00:04.000Z"),
            &books,
        );
        let fills = response["trades"]
            .as_array()
            .unwrap()
            .iter()
            .map(|trade| decimal::parse(trade["quantity"].as_str().unwrap()).unwrap())
            .collect::<Vec<i128>>();

        assert_eq!(fills.len(), 3);
        assert_eq!(fills.iter().sum::<i128>(), decimal::parse("0.3").unwrap());
        assert_eq!(response["takerStatus"], json!("filled"));
        assert_eq!(response["trades"][2]["makerRemainingQuantity"], json!("0"));

        let snapshot = command(json!({"action": "snapshot", "market": "BTC-USDT"}), &books);
        assert_eq!(snapshot["asks"][0]["orderId"], json!("m4"));
        assert_eq!(snapshot["asks"][0]["quantity"], json!("5"));
    }

    #[test]
    fn fok_is_met_when_liquidity_equals_quantity_exactly() {
        // f64: 0.1 + 0.7 == 0.7999999999999999 < 0.8, which would wrongly
        // reject this FOK without an epsilon fudge.
        let books = shared_books();
        command(seed("m1", "BTC-USDT", "sell", "100", "0.1", "2026-03-10T10:00:00.000Z"), &books);
        command(seed("m2", "BTC-USDT", "sell", "100", "0.7", "2026-03-10T10:00:01.000Z"), &books);

        let response = command(
            submit("t", "BTC-USDT", "buy", "limit", "fok", Some("100"), "0.8", "2026-03-10T10:00:02.000Z"),
            &books,
        );

        assert_eq!(response["outcome"], json!("matched"));
        assert_eq!(response["takerStatus"], json!("filled"));
        assert_eq!(response["takerRemainingQuantity"], json!("0"));
    }

    #[test]
    fn quantities_below_the_old_epsilon_still_trade() {
        // The float engine treated anything <= 1e-8 as zero.
        let books = shared_books();
        command(seed("m1", "BTC-USDT", "sell", "100", "0.000000001", "2026-03-10T10:00:00.000Z"), &books);

        let response = command(
            submit("t", "BTC-USDT", "buy", "limit", "fok", Some("100"), "0.000000001", "2026-03-10T10:00:01.000Z"),
            &books,
        );

        assert_eq!(response["takerStatus"], json!("filled"));
        assert_eq!(response["trades"][0]["quantity"], json!("0.000000001"));
    }

    #[test]
    fn rejects_invalid_decimal_inputs_with_existing_error_codes() {
        let books = shared_books();
        let cases = [
            (Some("100"), "-1", "INVALID_QUANTITY", "quantity must be positive"),
            (Some("100"), "0", "INVALID_QUANTITY", "quantity must be positive"),
            (Some("100"), "0.0000000000000000001", "INVALID_QUANTITY", ""),
            (Some("100"), "1e3", "INVALID_QUANTITY", ""),
            (Some("0"), "1", "INVALID_PRICE", "price must be positive"),
            (Some("-5"), "1", "INVALID_PRICE", "price must be positive"),
            (Some("NaN"), "1", "INVALID_PRICE", ""),
            (None, "1", "PRICE_REQUIRED", "limit order price is required"),
        ];

        for (price, quantity, code, message) in cases {
            let response = command(
                submit("t", "BTC-USDT", "buy", "limit", "gtc", price, quantity, "2026-03-10T10:00:00.000Z"),
                &books,
            );
            assert_eq!(response["error"]["code"], json!(code), "{price:?} {quantity}");
            if !message.is_empty() {
                assert_eq!(response["error"]["message"], json!(message));
            }
        }

        let seeded = command(seed("s", "BTC-USDT", "sell", "1.5", "0.1234567890123456789", "2026-03-10T10:00:00.000Z"), &books);
        assert_eq!(seeded["error"]["code"], json!("INVALID_QUANTITY"));
    }

    #[test]
    fn reset_keeps_sequences_and_restore_only_moves_forward() {
        let books: SharedBooks = Arc::new(Mutex::new(HashMap::new()));
        let restored = command(
            json!({"action": "restore", "market": "ETH-USDT", "next_execution_sequence": 42, "next_batch_sequence": 7}),
            &books,
        );
        assert_eq!(restored["nextExecutionSequence"], 42);

        let stale = command(
            json!({"action": "restore", "market": "ETH-USDT", "next_execution_sequence": 3, "next_batch_sequence": 1}),
            &books,
        );
        assert_eq!(stale["nextExecutionSequence"], 42);
        assert_eq!(stale["nextBatchSequence"], 7);

        let reset = command(json!({"action": "reset", "market": "ETH-USDT"}), &books);
        assert_eq!(reset["nextExecutionSequence"], 42);

        let snapshot = command(json!({"action": "snapshot", "market": "ETH-USDT"}), &books);
        assert_eq!(snapshot["nextExecutionSequence"], 42);
        assert_eq!(snapshot["nextBatchSequence"], 7);

        let wiped = command(
            json!({"action": "reset", "market": "ETH-USDT", "reset_sequences": true}),
            &books,
        );
        assert_eq!(wiped["nextExecutionSequence"], 1);
        assert_eq!(wiped["nextBatchSequence"], 1);
    }

    /// Markets are plain strings keyed by the order-service (config/markets.json);
    /// a newly listed market such as SOL-USDT needs no engine change.
    #[test]
    fn any_configured_market_symbol_gets_its_own_book() {
        let books = shared_books();
        command(seed("sol-ask", "SOL-USDT", "sell", "150.25", "12.5", "2026-10-10T10:00:00.000Z"), &books);
        command(seed("eth-ask", "ETH-USDT", "sell", "3200", "1", "2026-10-10T10:00:01.000Z"), &books);

        let fill = command(
            submit("sol-buy", "SOL-USDT", "buy", "limit", "ioc", Some("150.25"), "2.5", "2026-10-10T10:00:02.000Z"),
            &books,
        );
        assert_eq!(fill["outcome"], json!("matched"));
        assert_eq!(fill["trades"][0]["replayCursor"], json!("SOL-USDT:1"));

        let sol = command(json!({"action": "snapshot", "market": "SOL-USDT", "limit": 10}), &books);
        assert_eq!(sol["asks"][0]["quantity"], json!("10"));
        let eth = command(json!({"action": "snapshot", "market": "ETH-USDT", "limit": 10}), &books);
        assert_eq!(eth["asks"][0]["price"], json!("3200"));
    }
}
