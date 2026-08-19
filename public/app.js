const form = document.querySelector("#generatorForm");
const urlInput = document.querySelector("#postUrl");
const generateButton = document.querySelector("#generateButton");
const statusEl = document.querySelector("#status");
const postOutput = document.querySelector("#postOutput");
const copyButton = document.querySelector("#copyButton");
const regeneratePostButton = document.querySelector("#regeneratePostButton");
const image1 = document.querySelector("#image1");
const image2 = document.querySelector("#image2");
const emptyImage1 = document.querySelector("#emptyImage1");
const emptyImage2 = document.querySelector("#emptyImage2");
const image1Text = document.querySelector("#image1Text");
const image2Text = document.querySelector("#image2Text");
const downloadImage1 = document.querySelector("#downloadImage1");
const downloadImage2 = document.querySelector("#downloadImage2");
const regenerateImage1Button = document.querySelector("#regenerateImage1Button");
const regenerateImage2Button = document.querySelector("#regenerateImage2Button");
const insights = document.querySelector("#insights");
const originality = document.querySelector("#originality");
const researchUsed = document.querySelector("#researchUsed");
let currentGenerationId = "";

form.addEventListener("submit", async event => {
  event.preventDefault();
  setLoading(true);
  clearResults();

  try {
    setStatus("Reading the source post...");
    const response = await fetch("/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: urlInput.value })
    });

    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Something went wrong.");

    showResults(data);
    setStatus("Done. Review the post and images before using them.");
  } catch (error) {
    setStatus(error.message || "Something went wrong.", true);
  } finally {
    setLoading(false);
  }
});

copyButton.addEventListener("click", async () => {
  await navigator.clipboard.writeText(postOutput.value);
  const oldText = copyButton.textContent;
  copyButton.textContent = "Copied";
  setTimeout(() => {
    copyButton.textContent = oldText;
  }, 1200);
});

regeneratePostButton.addEventListener("click", async () => {
  if (!currentGenerationId) return;
  await runRegeneration(regeneratePostButton, "Regenerating only the post...", "/api/regenerate-post", {
    generationId: currentGenerationId
  }, data => {
    postOutput.value = data.post || "";
    renderInsights(data.insights || []);
    renderResearch(data.researchUsed || []);
    originality.textContent = data.originality || "";
  });
});

regenerateImage1Button.addEventListener("click", async () => {
  if (!currentGenerationId) return;
  await runRegeneration(regenerateImage1Button, "Regenerating only Image 1...", "/api/regenerate-image", {
    generationId: currentGenerationId,
    imageNumber: 1
  }, data => {
    setImage(image1, emptyImage1, downloadImage1, data.image1?.dataUrl);
    image1Text.textContent = data.image1?.explanation || "";
  });
});

regenerateImage2Button.addEventListener("click", async () => {
  if (!currentGenerationId) return;
  await runRegeneration(regenerateImage2Button, "Regenerating only Image 2...", "/api/regenerate-image", {
    generationId: currentGenerationId,
    imageNumber: 2
  }, data => {
    setImage(image2, emptyImage2, downloadImage2, data.image2?.dataUrl);
    image2Text.textContent = data.image2?.explanation || "";
  });
});

function showResults(data) {
  currentGenerationId = data.generationId || "";
  postOutput.value = data.post || "";
  copyButton.disabled = !postOutput.value;
  setRegenerateEnabled(Boolean(currentGenerationId));

  setImage(image1, emptyImage1, downloadImage1, data.image1?.dataUrl);
  setImage(image2, emptyImage2, downloadImage2, data.image2?.dataUrl);

  image1Text.textContent = data.image1?.explanation || "";
  image2Text.textContent = data.image2?.explanation || "";

  renderInsights(data.insights || []);
  renderResearch(data.researchUsed || []);
  originality.textContent = data.originality || "";
}

function setImage(img, empty, link, dataUrl) {
  if (!dataUrl) return;
  img.src = dataUrl;
  img.style.display = "block";
  empty.style.display = "none";
  link.href = dataUrl;
  link.download = dataUrl.startsWith("data:image/svg+xml")
    ? link.download.replace(/\.png$/i, ".svg")
    : link.download.replace(/\.svg$/i, ".png");
  link.classList.remove("disabled");
}

function clearResults() {
  currentGenerationId = "";
  postOutput.value = "";
  copyButton.disabled = true;
  setRegenerateEnabled(false);
  for (const img of [image1, image2]) {
    img.removeAttribute("src");
    img.style.display = "none";
  }
  for (const empty of [emptyImage1, emptyImage2]) {
    empty.style.display = "grid";
  }
  for (const link of [downloadImage1, downloadImage2]) {
    link.removeAttribute("href");
    link.classList.add("disabled");
  }
  image1Text.textContent = "";
  image2Text.textContent = "";
  insights.innerHTML = "";
  researchUsed.innerHTML = "";
  originality.textContent = "";
}

function setLoading(isLoading) {
  generateButton.disabled = isLoading;
  urlInput.disabled = isLoading;
  setRegenerateEnabled(!isLoading && Boolean(currentGenerationId));
  generateButton.textContent = isLoading ? "Generating..." : "Generate";
}

function setStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.classList.toggle("error", isError);
}

async function runRegeneration(button, loadingText, endpoint, payload, applyResult) {
  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = "Working...";
  setStatus(loadingText);

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Something went wrong.");
    applyResult(data);
    setStatus("Done. Review the updated result before using it.");
  } catch (error) {
    setStatus(error.message || "Something went wrong.", true);
  } finally {
    button.textContent = originalText;
    button.disabled = !currentGenerationId;
  }
}

function renderInsights(items) {
  insights.innerHTML = "";
  for (const item of items) {
    const li = document.createElement("li");
    li.textContent = item;
    insights.appendChild(li);
  }
}

function renderResearch(items) {
  researchUsed.innerHTML = "";
  for (const item of items) {
    const li = document.createElement("li");
    const link = document.createElement("a");
    link.href = item.url;
    link.target = "_blank";
    link.rel = "noreferrer";
    link.textContent = item.source || "Source";
    li.append(link, `: ${item.fact || "Context used."}`);
    researchUsed.appendChild(li);
  }
  if (!items.length) {
    const li = document.createElement("li");
    li.textContent = "No extra source materially influenced this generation.";
    researchUsed.appendChild(li);
  }
}

function setRegenerateEnabled(enabled) {
  regeneratePostButton.disabled = !enabled;
  regenerateImage1Button.disabled = !enabled;
  regenerateImage2Button.disabled = !enabled;
}
