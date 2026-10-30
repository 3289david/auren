'use strict';
// Docs site: search across all pages, copy buttons on code blocks, highlight the current section in "On this page".
(() => {
  const $ = (id) => document.getElementById(id);

  // copy buttons
  document.querySelectorAll('.doc .codebox').forEach((box) => {
    const b = document.createElement('button');
    b.className = 'copy'; b.type = 'button'; b.textContent = 'Copy';
    b.onclick = async () => { try { await navigator.clipboard.writeText(box.querySelector('code').innerText); b.textContent = 'Copied'; setTimeout(() => { b.textContent = 'Copy'; }, 1500); } catch { /* clipboard blocked */ } };
    box.appendChild(b);
  });

  // search
  let index = null;
  const input = $('dsearch'), out = $('dresults'), nav = $('dnav');
  if (input) {
    const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const load = () => index || (index = fetch('search.json').then((r) => r.json()).catch(() => []));
    input.addEventListener('focus', load);
    input.addEventListener('input', async () => {
      const q = input.value.trim().toLowerCase();
      if (q.length < 2) { out.hidden = true; nav.hidden = false; return; }
      const words = q.split(/\s+/);
      const pages = await load();
      const hits = pages.map((p) => {
        const title = p.t.toLowerCase(), heads = p.h.toLowerCase(), text = p.x.toLowerCase();
        let score = 0;
        for (const w of words) {
          if (!(title.includes(w) || heads.includes(w) || text.includes(w))) return null;
          score += (title.includes(w) ? 10 : 0) + (heads.includes(w) ? 4 : 0) + (text.includes(w) ? 1 : 0);
        }
        const at = text.indexOf(words[0]);
        return { p, score, snip: at >= 0 ? p.x.slice(Math.max(0, at - 40), at + 90) : '' };
      }).filter(Boolean).sort((a, b) => b.score - a.score).slice(0, 8);
      nav.hidden = true; out.hidden = false;
      out.innerHTML = hits.length
        ? hits.map((h) => `<a href="${h.p.u}"><b>${esc(h.p.t)}</b><small>${esc(h.snip)}</small></a>`).join('')
        : '<p class="muted">No results.</p>';
    });
  }

  // current section in the right-hand list
  const links = [...document.querySelectorAll('.docs-toc a')];
  if (links.length && 'IntersectionObserver' in window) {
    const map = new Map(links.map((a) => [a.getAttribute('href').slice(1), a]));
    const obs = new IntersectionObserver((es) => {
      for (const e of es) if (e.isIntersecting) { links.forEach((a) => a.classList.remove('on')); const a = map.get(e.target.id); if (a) a.classList.add('on'); }
    }, { rootMargin: '-70px 0px -70% 0px' });
    document.querySelectorAll('.doc h2[id]').forEach((h) => obs.observe(h));
  }
})();
