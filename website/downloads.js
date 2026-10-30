'use strict';
// Download buttons: point each [data-dl] link at the newest GitHub release file, show its size, and
// highlight the one for this computer. If GitHub cannot be reached the links open the releases page.
(() => {
  const REPO = '3289david/auren';
  const PAGE = `https://github.com/${REPO}/releases/latest`;
  const PATTERNS = {
    'node-win': /^AUREN-Node-.*\.exe$/, 'wallet-win': /^AUREN-Wallet-.*\.exe$/,
    'node-apk': /^AUREN-Node-.*\.apk$/, 'wallet-apk': /^AUREN-Wallet-.*\.apk$/,
    'pkg-tgz': /^auren-.*\.tar\.gz$/, 'pkg-zip': /^auren-.*\.zip$/,
  };
  const ua = navigator.userAgent;
  const os = /Android/i.test(ua) ? 'apk' : /Windows/i.test(ua) ? 'win' : 'pkg';
  const links = [...document.querySelectorAll('[data-dl]')];
  links.forEach((a) => { a.href = PAGE; if (a.dataset.dl.endsWith(os) || (os === 'pkg' && a.dataset.dl === 'pkg-tgz')) a.classList.add('primary'); });
  const mb = (n) => (n / 1048576 >= 1 ? (n / 1048576).toFixed(0) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB');
  fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { accept: 'application/vnd.github+json' } })
    .then((r) => r.json()).then((rel) => {
      const tag = document.querySelectorAll('[data-dl-version]');
      tag.forEach((e) => { e.textContent = rel.tag_name; });
      for (const a of links) {
        const asset = (rel.assets || []).find((x) => PATTERNS[a.dataset.dl] && PATTERNS[a.dataset.dl].test(x.name));
        if (!asset) continue;
        a.href = asset.browser_download_url;
        const s = a.querySelector('small') || a.appendChild(Object.assign(document.createElement('small'), { className: 'dlsize' }));
        s.textContent = ' ' + mb(asset.size);
      }
    }).catch(() => { /* keep the releases page links */ });
})();
