const bridgePoll = async () => {
  try {
    const { poolsideApiToken } = await chrome.storage.local.get("poolsideApiToken");
    if (!poolsideApiToken) return;
    const response = await fetch("http://127.0.0.1:3100/bridge/next", {
      headers: { "x-poolside-api-token": poolsideApiToken }
    });
    if (response.status === 204) return;
    if (!response.ok) return;
    const command = await response.json();
    chrome.runtime.sendMessage({ type: "poolside-command", command });
  } catch {
    // La API puede estar detenida; el siguiente intervalo reintentará.
  }
};

setInterval(bridgePoll, 750);
bridgePoll();
