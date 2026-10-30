'use strict';
// Home page: one live card read from the network. If no node answers, it says so instead of showing numbers.
(() => {
  const $ = (id) => document.getElementById(id);
  const AUR = 1e9;
  const fmt = (n, d = 0) => Number(n).toLocaleString('en-US', { maximumFractionDigits: d });
  const fmtAur = (sparks, d = 4) => { const s = BigInt(sparks); return fmt(Number(s / 1000000000n) + Number(s % 1000000000n) / AUR, d); };

  let base = null;
  const saved = (() => { try { return localStorage.getItem('auren.rpc'); } catch { return null; } })();
  const get = async (p) => { const r = await fetch(base + p, { cache: 'no-store' }); if (!r.ok) throw new Error(r.statusText); return r.json(); };

  async function poll() {
    try {
      const [st, blocks] = await Promise.all([get('/status'), get('/blocks?limit=5')]);
      $('dot').className = 'dot on';
      $('net').textContent = st.network === 'mainnet' ? 'AUREN network' : `AUREN ${st.network}`;
      $('height').textContent = fmt(st.height);
      $('fee').textContent = fmtAur(st.transferFee, 5) + ' AUR';
      $('vals').textContent = st.concentration.activeValidators;
      $('supply').textContent = fmtAur(st.supply, 0);
      $('staked').textContent = fmtAur(st.bonded, 0);
      $('offline').style.display = 'none';
      $('strip').replaceChildren(...blocks.slice().reverse().map((b) => {
        const d = document.createElement('div'); d.className = 'blk';
        const t = document.createElement('b'); t.textContent = '#' + fmt(b.height);
        d.append(t, document.createTextNode(b.txCount === 1 ? '1 payment' : `${b.txCount} payments`));
        return d;
      }));
    } catch {
      $('dot').className = 'dot';
      $('offline').style.display = '';
    }
  }

  Aur.detectRpc(saved).then((u) => { base = u; poll(); setInterval(poll, 2500); });
})();
