function readInlineGames() {
  const el = document.getElementById("games-data");
  if (!el) return null;
  try {
    const data = JSON.parse(el.textContent || "[]");
    return Array.isArray(data) ? data : null;
  } catch {
    return null;
  }
}

async function loadGames() {
  const inline = readInlineGames();
  if (location.protocol === "file:" && inline) return inline;
  try {
    const res = await fetch("games.json", { cache: "no-store" });
    if (!res.ok) throw new Error(`Failed to load games.json (${res.status})`);
    const data = await res.json();
    if (!Array.isArray(data)) throw new Error("games.json must be an array");
    return data;
  } catch (err) {
    if (inline) return inline;
    throw err;
  }
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function renderCard(g) {
  const title = escapeHtml(g.title ?? g.id ?? "UNTITLED");
  const blurb = escapeHtml(g.blurb ?? "");
  const href = escapeHtml(g.href ?? "#");
  const tags = Array.isArray(g.tags) ? g.tags : [];
  const chips = tags.map(t => `<span class="chip">${escapeHtml(t)}</span>`).join("");

  return `
    <a class="card" href="${href}">
      <div class="body">
        <div class="titleRow">
          <div class="title">${title}</div>
          <div class="chips">${chips}</div>
        </div>
        <p class="desc">${blurb}</p>
        <div class="footer">
          <span class="play">PLAY</span>
          <span></span>
        </div>
      </div>
    </a>
  `;
}

async function main() {
  const grid = document.getElementById("grid");
  const error = document.getElementById("error");
  if (!grid) {
    console.warn("Missing #grid element; cannot render games.");
    return;
  }

  try {
    const games = await loadGames();
    grid.innerHTML = games.map(renderCard).join("");
  } catch (e) {
    console.error(e);
    if (error) {
      error.textContent = String(e?.message ?? e);
      error.style.display = "block";
    }
  }
}

main();
