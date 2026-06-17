import {
  MqttDirection,
  type ParsedTopic,
  type TopicChannel
} from "@communication/contracts";

export const WORKER_TOPIC_PATTERNS = ["sys/#", "data/up/#", "indicate/#"] as const;

const KNOWN_CHANNELS = new Set(["sys", "data", "indicate"]);

export const parseTopic = (topic: string): ParsedTopic => {
  const segments = topic.split("/").filter((segment) => segment.length > 0);
  const [channelRaw, directionRaw, deviceTypeRaw, deviceIdRaw] = segments;
  const channelKey = (channelRaw ?? "").toLowerCase();
  const channel: TopicChannel = KNOWN_CHANNELS.has(channelKey)
    ? (channelKey as TopicChannel)
    : "unknown";

  const dirKey = (directionRaw ?? "").toLowerCase();
  let direction: MqttDirection | null = null;
  if (dirKey === "up") {
    direction = MqttDirection.Inbound;
  } else if (dirKey === "down") {
    direction = MqttDirection.Outbound;
  }

  return {
    raw: topic,
    channel,
    direction,
    segments,
    deviceType: deviceTypeRaw ?? null,
    deviceId: deviceIdRaw ?? null,
    isValid: channel !== "unknown" && segments.length >= 4
  };
};

export const buildTopic = (
  channel: "sys" | "data" | "indicate",
  direction: "up" | "down" | "dev" | "server",
  deviceType: string,
  deviceId: string
): string => [channel, direction, deviceType, deviceId].join("/");
