import { Kafka, Partitioners, type Admin, type Producer } from "kafkajs";

import type { LedgerOutboxTransport } from "../application/ledger-outbox-publisher.js";
import type { OutboxEventRecord } from "../domain/types.js";
import { applyKafkaJsNode25CompatibilityPatch } from "./kafkajs-node25-compat.js";

interface KafkaTransportOptions {
  brokers: string[];
  clientId: string;
  topic: string;
  deadLetterTopic: string;
}

export class KafkaLedgerOutboxTransport implements LedgerOutboxTransport {
  private readonly kafka: Kafka;
  private readonly producer: Producer;
  private readonly admin: Admin;
  private ready = false;

  constructor(private readonly options: KafkaTransportOptions) {
    applyKafkaJsNode25CompatibilityPatch();
    this.kafka = new Kafka({
      clientId: options.clientId,
      brokers: options.brokers
    });
    this.producer = this.kafka.producer({
      createPartitioner: Partitioners.DefaultPartitioner
    });
    this.admin = this.kafka.admin();
  }

  async publish(events: OutboxEventRecord[]): Promise<void> {
    if (events.length === 0) {
      return;
    }

    await this.ensureReady();
    await this.producer.send({
      topic: this.options.topic,
      messages: events.map((event) => ({
        key: event.aggregateId,
        value: JSON.stringify(event),
        headers: {
          event_id: event.eventId,
          event_type: event.eventType,
          aggregate_type: event.aggregateType
        }
      }))
    });
  }

  async publishDeadLetter(params: {
    event: OutboxEventRecord;
    errorMessage: string;
    deadLetteredAt: string;
  }): Promise<void> {
    await this.ensureReady();
    await this.producer.send({
      topic: this.options.deadLetterTopic,
      messages: [
        {
          key: params.event.aggregateId,
          value: JSON.stringify({
            event: params.event,
            failure: {
              errorMessage: params.errorMessage,
              deadLetteredAt: params.deadLetteredAt
            }
          }),
          headers: {
            event_id: params.event.eventId,
            event_type: params.event.eventType,
            aggregate_type: params.event.aggregateType
          }
        }
      ]
    });
  }

  async disconnect(): Promise<void> {
    if (!this.ready) {
      return;
    }

    await this.producer.disconnect();
    await this.admin.disconnect();
    this.ready = false;
  }

  private async ensureReady(): Promise<void> {
    if (this.ready) {
      return;
    }

    await this.admin.connect();
    await this.admin.createTopics({
      waitForLeaders: true,
      topics: [
        {
          topic: this.options.topic,
          numPartitions: 1,
          replicationFactor: 1
        },
        {
          topic: this.options.deadLetterTopic,
          numPartitions: 1,
          replicationFactor: 1
        }
      ]
    });

    await this.producer.connect();
    this.ready = true;
  }
}
