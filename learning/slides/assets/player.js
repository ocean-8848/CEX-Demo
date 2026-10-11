/* Video deck player.
 * Structure: <div class="stage" data-ep="EP01" data-title="..."> <section class="scene" data-title="..."> ...visuals...
 *   <ol class="say"><li>step 0 narration</li><li>step 1 narration</li>...</ol> </section> ... </div>
 * Visual elements with data-step="k" appear at step k; data-until="k" hides them after step k; data-dim="k" dims them from step k.
 * A scene may set data-onstep="fnName"; window[fnName](sceneEl, step) runs on every step (must be idempotent: render state for that step).
 * Keys: → / Space / click = next, ← = previous, N = narration panel, Home = start. ?render=1 = capture mode (used by the renderer).
 */
(function () {
  const stage = document.querySelector('.stage');
  const scenes = [...stage.querySelectorAll('section.scene')];
  const render = new URLSearchParams(location.search).has('render');
  if (render) document.body.classList.add('render');

  const meta = scenes.map((el, i) => {
    const items = [...el.querySelectorAll('ol.say > li')].map(li => li.textContent.replace(/\s+/g, ' ').trim());
    return { el, title: el.dataset.title || ('场景 ' + (i + 1)), steps: items.length ? items : [''] };
  });
  const flat = [];
  meta.forEach((m, si) => m.steps.forEach((_, st) => flat.push([si, st])));

  const badge = document.createElement('div');
  badge.className = 'ep-badge';
  badge.innerHTML = `${stage.dataset.ep || ''}<span>${stage.dataset.title || ''}</span>`;
  const progress = document.createElement('div'); progress.className = 'progress';
  const caption = document.createElement('div'); caption.className = 'caption';
  stage.append(badge, progress, caption);
  const hud = document.createElement('div'); hud.className = 'hud';
  const notes = document.createElement('div'); notes.className = 'notes-panel';
  document.body.append(hud, notes);

  function fit() {
    const s = Math.min(innerWidth / 1920, innerHeight / 1080);
    stage.style.transform = `translate(-50%, -50%) scale(${s})`;
  }
  addEventListener('resize', fit); fit();

  let cur = 0;
  function apply(si, st) {
    scenes.forEach((el, i) => el.classList.toggle('active', i === si));
    const el = scenes[si];
    el.querySelectorAll('[data-step]').forEach(n => {
      const k = +n.dataset.step;
      const until = n.dataset.until !== undefined ? +n.dataset.until : Infinity;
      n.classList.toggle('shown', st >= k && st <= until);
    });
    el.querySelectorAll('[data-dim]').forEach(n => n.classList.toggle('dim', st >= +n.dataset.dim));
    const fn = el.dataset.onstep;
    if (fn && typeof window[fn] === 'function') { try { window[fn](el, st); } catch (e) { console.error(e); } }
    const idx = flat.findIndex(([a, b]) => a === si && b === st);
    progress.style.width = ((idx + 1) / flat.length * 100) + '%';
    hud.textContent = `${si + 1}.${st} / ${scenes.length} 场景 · ${meta[si].title}`;
    notes.textContent = meta[si].steps[st];
    if (!render) history.replaceState(null, '', '#s' + (si + 1) + '-' + st);
  }
  function goFlat(i) { cur = Math.max(0, Math.min(flat.length - 1, i)); apply(...flat[cur]); }

  addEventListener('keydown', e => {
    if (render) return;
    if (['ArrowRight', ' ', 'PageDown', 'Enter'].includes(e.key)) { e.preventDefault(); goFlat(cur + 1); }
    else if (['ArrowLeft', 'PageUp', 'Backspace'].includes(e.key)) { e.preventDefault(); goFlat(cur - 1); }
    else if (e.key === 'Home') goFlat(0);
    else if (e.key.toLowerCase() === 'n') document.body.classList.toggle('notes');
  });
  stage.addEventListener('click', e => { if (!render && !e.target.closest('a,button,input,iframe')) goFlat(cur + 1); });

  window.deck = {
    ep: stage.dataset.ep, title: stage.dataset.title,
    scenes: meta.map(m => ({ title: m.title, steps: m.steps })),
    go(si, st) { cur = flat.findIndex(([a, b]) => a === si && b === st); apply(si, st); },
    caption(text) { caption.textContent = text || ''; caption.classList.toggle('on', !!text); },
    settleMs: 700,
  };

  const m = location.hash.match(/^#s(\d+)-(\d+)$/);
  const start = m ? flat.findIndex(([a, b]) => a === +m[1] - 1 && b === +m[2]) : 0;
  goFlat(start < 0 ? 0 : start);
})();
