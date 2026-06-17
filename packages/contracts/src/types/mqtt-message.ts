import { MqttDirection } from "./mqtt-direction.js";

export type TopicChannel = "sys" | "data" | "indicate" | "unknown";

export interface ParsedTopic {
  raw: string;
  channel: TopicChannel;
  direction: MqttDirection | null;
  segments: string[];
  deviceType: string | null;
  deviceId: string | null;
  isValid: boolean;
}

export interface NormalizedIncomingMessage {
  topic: ParsedTopic;
  sn: string | null;
  method: string | null;
  msgid: string | null;
  timestamp: string | null;
  /** Acrel-like: subset of `reported` for `update` method. */
  reportedSummary: Record<string, unknown> | null;
  /** Acrel-like: `res` on operate / indicate ack. */
  operateRes: string | null;
  payloadJson: Record<string, unknown> | null;
  payloadText: string;
  payloadParseError: string | null;
}
