type SimulatorDeviceState = {
  switchState: 0 | 1;
  lastMsgid: string | null;
};

export interface SimulatorService {
  simulatePublishedCommand: (
    topic: string,
    payloadObj: Record<string, unknown>,
    deliverInbound: (topic: string, payloadText: string) => Promise<void>
  ) => void;
}

const ACK_DELAY_MS = 100;
const UPDATE_DELAY_MS = 250;

const deviceStateBySn = new Map<string, SimulatorDeviceState>();

const asObject = (value: unknown): Record<string, unknown> | null => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
};

const toSwitchState = (value: unknown): 0 | 1 | null => {
  if (value === 0 || value === "0") {
    return 0;
  }
  if (value === 1 || value === "1") {
    return 1;
  }
  return null;
};

const parseOutboundTopic = (
  topic: string
): { productKey: string; sn: string } | null => {
  const segments = topic.split("/");
  const [, , productKey, sn] = segments;
  const isIndicateServer =
    segments[0] === "indicate" && segments[1] === "server";
  const isSysServer = segments[0] === "sys" && segments[1] === "server";
  if (
    segments.length !== 4 ||
    (!isIndicateServer && !isSysServer) ||
    typeof productKey !== "string" ||
    typeof sn !== "string" ||
    productKey.length === 0 ||
    sn.length === 0
  ) {
    return null;
  }

  return {
    productKey,
    sn
  };
};

const getOrCreateDeviceState = (sn: string): SimulatorDeviceState => {
  const existing = deviceStateBySn.get(sn);
  if (existing) {
    return existing;
  }

  const created: SimulatorDeviceState = {
    switchState: 1,
    lastMsgid: null
  };
  deviceStateBySn.set(sn, created);
  return created;
};

const schedule = (delayMs: number, work: () => Promise<void>): void => {
  setTimeout(() => {
    void work();
  }, delayMs);
};

export const createSimulatorService = (): SimulatorService => {
  return {
    simulatePublishedCommand: (topic, payloadObj, deliverInbound) => {
      const route = parseOutboundTopic(topic);
      if (!route) {
        return;
      }

      const inner = asObject(payloadObj.payload);
      const innerMethod =
        typeof inner?.method === "string" ? inner.method.trim().toUpperCase() : "";
      const msgidRaw = payloadObj.msgid;
      const msgid =
        typeof msgidRaw === "string"
          ? msgidRaw
          : typeof msgidRaw === "number"
            ? String(msgidRaw)
            : `sim-${Date.now()}`;
      const state = getOrCreateDeviceState(route.sn);
      state.lastMsgid = msgid;

      if (innerMethod === "FORCESWITCH" && inner) {
        const forced = toSwitchState(inner.ForceSwitch ?? inner.do1);
        if (forced !== null) {
          state.switchState = forced;
        }
      }

      const ackTopic = `indicate/dev/${route.productKey}/${route.sn}`;
      const nowUnix = Math.floor(Date.now() / 1000);
      const ackBody: Record<string, unknown> = {
        sn: route.sn,
        method: "operate",
        msgid,
        timestamp: nowUnix,
        res: 1
      };
      if (innerMethod === "REFRESH") {
        ackBody.reported = { SwitchSta: state.switchState };
      }
      const ackPayload = JSON.stringify(ackBody);

      schedule(ACK_DELAY_MS, async () => {
        await deliverInbound(ackTopic, ackPayload);
      });

      // Real devices reflect switch changes in their next telemetry cycle; emit a data/up update
      // after FORCESWITCH (not just REFRESH) so verify + reconcile can confirm reported == desired.
      if (innerMethod !== "REFRESH" && innerMethod !== "FORCESWITCH") {
        return;
      }

      const updateTopic = `data/up/${route.productKey}/${route.sn}`;
      const updatePayload = JSON.stringify({
        sn: route.sn,
        method: "update",
        msgid: `${msgid}-update`,
        timestamp: new Date().toISOString(),
        reported: {
          state: 1,
          Ua: 229.4,
          Ia: 5.12,
          P: 1174.5,
          PF: 0.98,
          EPI: 12345.67,
          Balance: 0,
          SwitchSta: state.switchState
        }
      });

      schedule(UPDATE_DELAY_MS, async () => {
        await deliverInbound(updateTopic, updatePayload);
      });
    }
  };
};
