const tokenInput = document.querySelector("#token");
const status = document.querySelector("#status");

chrome.storage.local.get("poolsideApiToken").then(({ poolsideApiToken }) => {
  tokenInput.value = poolsideApiToken || "";
});

document.querySelector("#save").addEventListener("click", async () => {
  const poolsideApiToken = tokenInput.value.trim();
  if (poolsideApiToken.length < 32) {
    status.textContent = "El token debe tener al menos 32 caracteres.";
    return;
  }
  await chrome.storage.local.set({ poolsideApiToken });
  status.textContent = "Token guardado.";
});
