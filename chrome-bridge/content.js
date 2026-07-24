const basePollMs = 750;
const maxPollMs = 30_000;
let pollMs = basePollMs;
let timer;

const schedule = () => {
  clearTimeout(timer);
  timer = setTimeout(bridgePoll, pollMs);
};

// Si la API local está detenida no tiene sentido insistir cada 750 ms: el
// intervalo crece hasta 30 s y vuelve al ritmo normal en cuanto responde.
const backOff = () => {
  pollMs = Math.min(pollMs * 2, maxPollMs);
};

async function bridgePoll() {
  try {
    const { poolsideApiToken } = await chrome.storage.local.get("poolsideApiToken");
    if (!poolsideApiToken) return backOff();
    const response = await fetch("http://127.0.0.1:3100/bridge/next", {
      headers: { "x-poolside-api-token": poolsideApiToken }
    });
    if (!response.ok && response.status !== 204) return backOff();
    pollMs = basePollMs;
    if (response.status === 204) return;
    const command = await response.json();
    chrome.runtime.sendMessage({ type: "poolside-command", command });
  } catch {
    // La API puede estar detenida; el siguiente intento reintentará.
    backOff();
  } finally {
    schedule();
  }
}

bridgePoll();
