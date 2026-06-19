import mqtt from "mqtt";

const HOST = process.env.TEST_MQTT_HOST ?? "mqtt.volt4amper.com";
const PORT = Number(process.env.TEST_MQTT_PORT ?? 8883);
const USER = process.env.TEST_MQTT_USER ?? "fleet_device";
const PASS = process.env.TEST_MQTT_PASS ?? "";
const URL = `mqtts://${HOST}:${PORT}`;

const connect = (opts, label, timeoutMs = 12000) =>
  new Promise((resolve) => {
    const client = mqtt.connect(URL, {
      connectTimeout: timeoutMs,
      reconnectPeriod: 0,
      rejectUnauthorized: true,
      ...opts
    });
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      try {
        client.end(true);
      } catch {}
      resolve(result);
    };
    const timer = setTimeout(() => done({ ok: false, reason: "timeout" }), timeoutMs + 1000);
    client.on("connect", () => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      // Basarili baglantida client'i KAPATMA — cagiran tarafi yeniden kullaniyor.
      resolve({ ok: true, client });
    });
    client.on("error", (err) => {
      clearTimeout(timer);
      done({ ok: false, reason: err?.message ?? String(err), code: err?.code });
    });
  });

const main = async () => {
  if (!PASS) {
    console.error("TEST_MQTT_PASS bos — fleet_device parolasini ver");
    process.exit(2);
  }
  console.log(`[test] hedef ${URL} kullanici=${USER}`);

  // 1) Gecerli TLS + dogru kimlik: baglanmali, pub/sub round-trip.
  console.log("[test] 1/3 dogru kimlik + gecerli TLS ...");
  const good = await connect({ username: USER, password: PASS, clientId: `conntest-${Date.now()}` }, "good");
  if (!good.ok) {
    console.error(`[test] BASARISIZ: dogru kimlikle baglanilamadi -> ${good.reason} ${good.code ?? ""}`);
    process.exit(1);
  }
  console.log("[test]   baglandi (TLS dogrulandi, kimlik kabul edildi)");

  const topic = `data/conntest/${Date.now()}`;
  const payload = `ping-${Math.random().toString(36).slice(2)}`;
  const roundTrip = await new Promise((resolve) => {
    const c = good.client;
    const t = setTimeout(() => {
      console.log("[test]   (round-trip zaman asimi: mesaj geri gelmedi)");
      resolve(false);
    }, 8000);
    c.on("message", (tp, msg) => {
      if (tp === topic && msg.toString() === payload) {
        clearTimeout(t);
        resolve(true);
      }
    });
    c.subscribe(topic, { qos: 1 }, (err, granted) => {
      if (err) {
        console.log(`[test]   subscribe HATA: ${err.message}`);
        clearTimeout(t);
        resolve(false);
        return;
      }
      console.log(`[test]   subscribe granted: ${JSON.stringify(granted)}`);
      const denied = Array.isArray(granted) && granted.some((g) => g.qos === 128);
      if (denied) {
        console.log("[test]   subscribe REDDEDILDI (authz topic'e izin vermiyor)");
        clearTimeout(t);
        resolve(false);
        return;
      }
      c.publish(topic, payload, { qos: 1 }, (perr) => {
        if (perr) console.log(`[test]   publish HATA: ${perr.message}`);
      });
    });
  });
  try {
    good.client.end(true);
  } catch {}
  console.log(roundTrip ? "[test]   pub/sub round-trip OK" : "[test]   pub/sub round-trip BASARISIZ");

  // 2) Yanlis parola: reddedilmeli.
  console.log("[test] 2/3 yanlis parola (reddedilmeli) ...");
  const bad = await connect({ username: USER, password: "kesinlikle-yanlis-parola", clientId: `conntest-bad-${Date.now()}` }, "bad");
  console.log(bad.ok ? "[test]   UYARI: yanlis parola KABUL edildi (auth zayif!)" : `[test]   dogru sekilde reddedildi (${bad.reason})`);

  // 3) Anonim: reddedilmeli.
  console.log("[test] 3/3 anonim baglanti (reddedilmeli) ...");
  const anon = await connect({ clientId: `conntest-anon-${Date.now()}` }, "anon");
  console.log(anon.ok ? "[test]   UYARI: anonim baglanti KABUL edildi (auth zayif!)" : `[test]   dogru sekilde reddedildi (${anon.reason})`);

  const pass = good.ok && roundTrip && !bad.ok && !anon.ok;
  console.log(pass ? "\n[test] SONUC: GECTI" : "\n[test] SONUC: incelenmeli");
  process.exit(pass ? 0 : 1);
};

main().catch((e) => {
  console.error("[test] FATAL", e);
  process.exit(1);
});
