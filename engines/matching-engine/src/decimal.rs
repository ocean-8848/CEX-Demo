//! Fixed-point decimal helpers for the matching engine.
//!
//! Prices and quantities are carried as `i128` "atomic units" with
//! [`SCALE`] = 18 fractional digits, matching the ledger's 18-decimal NUMERIC
//! columns. `1` is stored as `10^18`, `0.05` as `5 * 10^16`. Addition,
//! subtraction and comparison are therefore exact: `0.1 + 0.2 == 0.3` holds,
//! which is not true for `f64`.

use std::fmt;

/// Number of fractional decimal digits carried by an atomic unit.
pub const SCALE: u32 = 18;

/// `10^SCALE`, the atomic-unit value of `1`.
pub const ONE: i128 = 1_000_000_000_000_000_000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DecimalError {
    Empty,
    Negative,
    InvalidCharacter(char),
    MissingIntegerDigits,
    MissingFractionDigits,
    TooManyFractionDigits(usize),
    Overflow,
}

impl fmt::Display for DecimalError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            DecimalError::Empty => write!(f, "empty decimal string"),
            DecimalError::Negative => write!(f, "negative values are not allowed"),
            DecimalError::InvalidCharacter(c) => write!(f, "invalid character {c:?}"),
            DecimalError::MissingIntegerDigits => write!(f, "missing integer digits"),
            DecimalError::MissingFractionDigits => write!(f, "missing fraction digits after '.'"),
            DecimalError::TooManyFractionDigits(n) => {
                write!(f, "{n} fractional digits exceeds the maximum of {SCALE}")
            }
            DecimalError::Overflow => write!(f, "value is out of range"),
        }
    }
}

/// Parses a non-negative plain decimal string (`"3200"`, `"0.05"`,
/// `"0.40"`) into atomic units.
///
/// Rejected: empty input, signs, exponents, whitespace, more than 18
/// fractional digits (they cannot be represented exactly), a bare `"."`,
/// `".5"` / `"5."`, and values that overflow `i128`.
pub fn parse(text: &str) -> Result<i128, DecimalError> {
    if text.is_empty() {
        return Err(DecimalError::Empty);
    }
    if text.starts_with('-') {
        return Err(DecimalError::Negative);
    }

    let (integer_part, fraction_part) = match text.split_once('.') {
        Some((integer, fraction)) => (integer, Some(fraction)),
        None => (text, None),
    };

    if integer_part.is_empty() {
        return Err(DecimalError::MissingIntegerDigits);
    }
    if let Some(c) = integer_part.chars().find(|c| !c.is_ascii_digit()) {
        return Err(DecimalError::InvalidCharacter(c));
    }

    let mut value: i128 = 0;
    for digit in integer_part.bytes() {
        value = value
            .checked_mul(10)
            .and_then(|v| v.checked_add(i128::from(digit - b'0')))
            .ok_or(DecimalError::Overflow)?;
    }
    value = value.checked_mul(ONE).ok_or(DecimalError::Overflow)?;

    if let Some(fraction) = fraction_part {
        if fraction.is_empty() {
            return Err(DecimalError::MissingFractionDigits);
        }
        if let Some(c) = fraction.chars().find(|c| !c.is_ascii_digit()) {
            return Err(DecimalError::InvalidCharacter(c));
        }
        if fraction.len() > SCALE as usize {
            return Err(DecimalError::TooManyFractionDigits(fraction.len()));
        }

        let mut fraction_value: i128 = 0;
        for digit in fraction.bytes() {
            fraction_value = fraction_value * 10 + i128::from(digit - b'0');
        }
        fraction_value *= 10i128.pow(SCALE - fraction.len() as u32);
        value = value.checked_add(fraction_value).ok_or(DecimalError::Overflow)?;
    }

    Ok(value)
}

/// Formats atomic units as a canonical decimal string: no trailing
/// fractional zeros and no trailing `.` (`"3200"`, `"0.05"`, `"0"`).
pub fn format(value: i128) -> String {
    let sign = if value < 0 { "-" } else { "" };
    let magnitude = value.unsigned_abs();
    let one = ONE as u128;
    let integer = magnitude / one;
    let fraction = magnitude % one;

    if fraction == 0 {
        return format!("{sign}{integer}");
    }

    let fraction_text = format!("{fraction:0width$}", width = SCALE as usize);
    format!("{sign}{integer}.{}", fraction_text.trim_end_matches('0'))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_integers_and_fractions() {
        assert_eq!(parse("0"), Ok(0));
        assert_eq!(parse("1"), Ok(ONE));
        assert_eq!(parse("3200"), Ok(3200 * ONE));
        assert_eq!(parse("0.05"), Ok(5 * ONE / 100));
        assert_eq!(parse("0.40"), Ok(4 * ONE / 10));
        assert_eq!(parse("65000.5"), Ok(65000 * ONE + ONE / 2));
        assert_eq!(parse("0.000000000000000001"), Ok(1));
        assert_eq!(parse("007.10"), Ok(7 * ONE + ONE / 10));
    }

    #[test]
    fn rejects_malformed_input() {
        assert_eq!(parse(""), Err(DecimalError::Empty));
        assert_eq!(parse("-1"), Err(DecimalError::Negative));
        assert_eq!(parse("-0.5"), Err(DecimalError::Negative));
        assert_eq!(parse("+1"), Err(DecimalError::InvalidCharacter('+')));
        assert_eq!(parse("1e3"), Err(DecimalError::InvalidCharacter('e')));
        assert_eq!(parse("abc"), Err(DecimalError::InvalidCharacter('a')));
        assert_eq!(parse(" 1"), Err(DecimalError::InvalidCharacter(' ')));
        assert_eq!(parse("1.2.3"), Err(DecimalError::InvalidCharacter('.')));
        assert_eq!(parse("NaN"), Err(DecimalError::InvalidCharacter('N')));
        assert_eq!(parse("inf"), Err(DecimalError::InvalidCharacter('i')));
        assert_eq!(parse("."), Err(DecimalError::MissingIntegerDigits));
        assert_eq!(parse(".5"), Err(DecimalError::MissingIntegerDigits));
        assert_eq!(parse("5."), Err(DecimalError::MissingFractionDigits));
    }

    #[test]
    fn rejects_more_than_eighteen_fraction_digits() {
        assert_eq!(parse("0.123456789012345678"), Ok(123_456_789_012_345_678));
        assert_eq!(
            parse("0.1234567890123456789"),
            Err(DecimalError::TooManyFractionDigits(19))
        );
        assert_eq!(
            parse("1.0000000000000000000"),
            Err(DecimalError::TooManyFractionDigits(19))
        );
    }

    #[test]
    fn rejects_overflow() {
        // i128::MAX / 10^18 is about 1.7e20.
        assert!(parse("170141183460469231731").is_ok());
        assert_eq!(parse("170141183460469231732"), Err(DecimalError::Overflow));
        assert_eq!(parse("99999999999999999999999999999999999999999"), Err(DecimalError::Overflow));
    }

    #[test]
    fn formats_canonically() {
        assert_eq!(format(0), "0");
        assert_eq!(format(3200 * ONE), "3200");
        assert_eq!(format(5 * ONE / 100), "0.05");
        assert_eq!(format(4 * ONE / 10), "0.4");
        assert_eq!(format(1), "0.000000000000000001");
        assert_eq!(format(65000 * ONE + ONE / 2), "65000.5");
        assert_eq!(format(-(ONE / 4)), "-0.25");
        assert_eq!(format(i128::MAX), "170141183460469231731.687303715884105727");
    }

    #[test]
    fn round_trips_canonical_strings() {
        for text in ["0", "1", "0.3", "0.05", "65010", "123.456", "0.000000000000000001"] {
            assert_eq!(format(parse(text).unwrap()), text);
        }
        assert_eq!(format(parse("0.40").unwrap()), "0.4");
        assert_eq!(format(parse("3200.000").unwrap()), "3200");
    }

    #[test]
    fn sums_are_exact() {
        let total = parse("0.1").unwrap() + parse("0.2").unwrap();
        assert_eq!(total, parse("0.3").unwrap());
        assert_eq!(format(total), "0.3");
        // The same arithmetic in f64 is famously inexact.
        assert_ne!(0.1f64 + 0.2f64, 0.3f64);
    }
}
