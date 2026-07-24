const bridgePoll = async () => {
  try {
    const response = await fetch("http://127.0.0.1:3100/bridge/next");
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
