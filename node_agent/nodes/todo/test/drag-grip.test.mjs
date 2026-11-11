// The grip is the row's handle, and it can fail in ways the source does not show: a handle too small
// for a thumb, a drag that saves on every frame, a drop that writes twice, a refused move that leaves
// the list in an order the node never agreed to. So the page is run the way it is used - the BUILT page
// (dist/ui.html, the one a node serves), in a browser, with a stub that records every `move` it is
// sent and can refuse one on purpose. Run `npm run build` first: a stale dist hands these the old page.
//
// The pointer is driven through the browser's own input, not by dispatching synthetic PointerEvents:
// `setPointerCapture` and the browser's default actions (scrolling, focus) only exist for real input.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { test } from 'node:test';

import { chromePath, openPage, startChrome } from '../../webui/tests/browser.mjs';

const SOURCE = new URL('../src/ui.html', import.meta.url);
const BUILT = new URL('../dist/ui.html', import.meta.url);

//: The smallest target a thumb hits reliably.
const TOUCH_TARGET = 44;

/** The three rows the stub hands out: open ones, newest id first - the node's own order before anyone
 *  has arranged them. A drag that moves anything has to move these. */
const TODOS = [
  { id: 3, title: 'review', text: '', done: false, at: '2026-01-02T09:00:00.000Z', doneAt: null },
  { id: 2, title: 'ship', text: '', done: false, at: '2026-01-04T09:00:00.000Z', doneAt: null },
  { id: 1, title: 'plan', text: '', done: false, at: '2026-01-01T09:00:00.000Z', doneAt: null },
];

/** A deployment in miniature that keeps the list: `move` is applied the way the node applies it (take
 *  the row out, put it next to the neighbour named), and every call is written down - the count is the
 *  question. `refuse` makes the next move fail the way a node that cannot write fails. */
async function serve() {
  const page = readFileSync(BUILT, 'utf8').replace('__NODE__', 'todo');
  let todos = TODOS.map((one) => ({ ...one }));
  const moves = [];
  const calls = [];
  let refuse = false;

  const server = createServer((req, res) => {
    const url = req.url ?? '/';
    if (url === '/webui/events-client.js' || url === '/webui/events-broker.js') {
      res.writeHead(200, { 'content-type': 'text/javascript' });
      res.end(readFileSync(new URL('../../webui/src/' + url.slice('/webui/'.length), import.meta.url), 'utf8'));
      return;
    }
    if (url === '/call') {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => {
        const { tool, args } = JSON.parse(body === '' ? '{}' : body);
        calls.push({ tool, args });
        let answer;
        if (tool === 'todo.list') answer = { ok: true, value: todos.map((one) => ({ ...one })) };
        else if (tool === 'todo.today') answer = { ok: true, value: { text: '', buttons: [], updatedAt: null } };
        else if (tool === 'todo.presses') answer = { ok: true, value: [] };
        else if (tool === 'todo.move' && !refuse) {
          moves.push(args);
          const one = todos.find((todo) => todo.id === args.id);
          const rest = todos.filter((todo) => todo !== one);
          const at = rest.findIndex((todo) => todo.id === (args.before ?? args.after));
          rest.splice(args.before !== undefined ? at : at + 1, 0, one);
          todos = rest;
          answer = { ok: true, value: `moved id=${one.id}` };
        } else if (tool === 'todo.move') {
          moves.push(args);
          answer = { ok: false, error: 'the store is not writable' };
        } else answer = { ok: false, error: `the stub has no ${tool}` };
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(answer));
      });
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(page);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: server.address().port,
    moves,
    calls,
    refuse: (on) => {
      refuse = on;
    },
    close: () => {
      server.closeAllConnections();
      server.close();
    },
  };
}

/** What a page says from the inside: the expression is evaluated in the page and its value comes back
 *  as data, never as a live object. */
async function look(page, expression) {
  const reply = await page.send('Runtime.evaluate', {
    expression: `JSON.stringify(${expression}) ?? 'null'`,
    returnByValue: true,
  });
  return JSON.parse(reply.result.result.value);
}

/** Poll instead of sleeping: fast when the page is already there, honest when it is not. */
async function until(page, expression, what) {
  for (let i = 0; i < 120; i += 1) {
    const reply = await page.send('Runtime.evaluate', {
      expression: `!!(${expression})`,
      returnByValue: true,
    });
    if (reply.result?.result?.value === true) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`the page never showed: ${what}`);
}

/** A real key press, dispatched into the page: the grip's lift, step and drop are the browser's own
 *  keydown path, and an untrusted KeyboardEvent never takes it. */
async function press(page, name) {
  const keys = {
    Enter: { code: 'Enter', keyCode: 13, text: '\r' },
    ' ': { code: 'Space', keyCode: 32, text: ' ' },
    Escape: { code: 'Escape', keyCode: 27 },
    Tab: { code: 'Tab', keyCode: 9 },
    ArrowUp: { code: 'ArrowUp', keyCode: 38 },
    ArrowDown: { code: 'ArrowDown', keyCode: 40 },
  };
  const one = keys[name];
  const base = {
    key: name,
    code: one.code,
    windowsVirtualKeyCode: one.keyCode,
    nativeVirtualKeyCode: one.keyCode,
  };
  await page.send('Input.dispatchKeyEvent', {
    type: one.text ? 'keyDown' : 'rawKeyDown',
    ...base,
    ...(one.text ? { text: one.text } : {}),
  });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
}

/** One page, one browser, one stub: what every test below needs and none of them wants to spell out. */
async function withPage(t, options, run) {
  if (!existsSync(BUILT)) {
    t.skip('dist/ is only there after `npm run build`');
    return;
  }
  const chrome = chromePath();
  if (!chrome) {
    t.skip('no chrome to measure with: set CHROME to a chromium binary');
    return;
  }
  const served = await serve();
  const browser = await startChrome(chrome);
  let page;
  try {
    page = await openPage(browser.page.webSocketDebuggerUrl);
    await page.send('Emulation.setDeviceMetricsOverride', {
      width: options.width,
      height: 800,
      deviceScaleFactor: 1,
      mobile: true,
    });
    if (options.touch) {
      await page.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
    }
    await page.send('Page.navigate', { url: `http://127.0.0.1:${served.port}/` });
    await until(page, "document.querySelectorAll('#list .row').length === 3", 'the stubbed list');
    await run(page, served);
  } finally {
    page?.close();
    browser.chrome.kill('SIGKILL');
    served.close();
  }
}

/** The browser's own mouse: these become pointer events with `pointerType: mouse`, which is what the
 *  grip listens for - a synthetic PointerEvent would prove nothing about capture or defaults. */
async function mouse(page, type, x, y) {
  await page.send('Input.dispatchMouseEvent', {
    type,
    x,
    y,
    button: 'left',
    buttons: type === 'mouseReleased' ? 0 : 1,
    clickCount: 1,
  });
}

/** The path a hand takes: press on the handle of one row, move until the finger is past the middle of
 *  the row it should trade places with, let go. `during` runs while the row is still in the air. */
async function dragByMouse(page, id, targetId, during) {
  const box = await look(
    page,
    `(() => {
      const grip = document.querySelector('.row[data-id="${id}"] .grip');
      const row = document.querySelector('.row[data-id="${targetId}"]');
      const held = grip.getBoundingClientRect();
      const other = row.getBoundingClientRect();
      return {
        x: Math.round(held.left + held.width / 2),
        y: Math.round(held.top + held.height / 2),
        to: Math.round(other.top + other.height / 2),
      };
    })()`,
  );
  await mouse(page, 'mousePressed', box.x, box.y);
  await mouse(page, 'mouseMoved', box.x, box.y + 6);
  await mouse(page, 'mouseMoved', box.x, box.to + 6);
  if (during) await during();
  await mouse(page, 'mouseReleased', box.x, box.to + 6);
}

const ORDER = "[...document.querySelectorAll('#list .row')].map((row) => row.dataset.id).join()";

// Requirement: every row has a handle on its left, and a thumb gets 44px of it at a phone's width -
// the width where the handle matters most and where a 30px one would be unusable.
test('every row carries a grip, and a thumb gets 44px of it', async (t) => {
  await withPage(t, { width: 390 }, async (page) => {
    const grips = await look(
      page,
      "[...document.querySelectorAll('#list .row')].map((row) => {" +
        " const grip = row.querySelector('.grip');" +
        ' if (grip === null) return { id: Number(row.dataset.id), missing: true };' +
        ' const box = grip.getBoundingClientRect();' +
        ' const style = getComputedStyle(grip);' +
        ' return {' +
        ' id: Number(row.dataset.id),' +
        ' first: row.firstElementChild === grip,' +
        ' width: Math.round(box.width),' +
        ' height: Math.round(box.height),' +
        ' touch: style.touchAction,' +
        ' opacity: Number(style.opacity),' +
        ' type: grip.type,' +
        ' disabled: grip.disabled,' +
        ' };' +
        ' })',
    );
    assert.deepEqual(
      grips.map((grip) => grip.id),
      [3, 2, 1],
      'the stubbed list is drawn, row by row',
    );
    for (const grip of grips) {
      assert.ok(!grip.missing, `row ${grip.id} has no handle`);
      assert.equal(grip.first, true, 'the handle is the first thing in the row: to the left of the box');
      assert.ok(
        grip.width >= TOUCH_TARGET && grip.height >= TOUCH_TARGET,
        `a handle smaller than a thumb target (row ${grip.id}): ${grip.width}x${grip.height}`,
      );
      assert.equal(
        grip.touch,
        'none',
        'touch-action: none on the handle is what lets a finger drag the row instead of scrolling',
      );
      assert.equal(grip.type, 'button', 'the handle is a button, so a keyboard can reach it');
      assert.equal(grip.disabled, false, 'hand order is the view, so the handle works');
      assert.equal(grip.opacity, 1, 'a handle drawn on hover is a handle a phone never sees');
    }
    // The page still scrolls: `touch-action: none` is on the handle, and nowhere else.
    assert.equal(await look(page, 'getComputedStyle(document.body).touchAction'), 'auto');
    assert.equal(await look(page, "getComputedStyle(document.getElementById('list')).touchAction"), 'auto');
  });
});

// Requirement: the handle says what it is, in English, to a reader who never sees the dots.
test('the grip says what it does: aria-label="Drag to reorder"', async (t) => {
  await withPage(t, { width: 900 }, async (page) => {
    assert.deepEqual(
      await look(page, "[...document.querySelectorAll('#list .grip')].map((grip) => grip.getAttribute('aria-label'))"),
      ['Drag to reorder', 'Drag to reorder', 'Drag to reorder'],
      'every handle carries the same name',
    );
    assert.equal(
      await look(page, "document.querySelector('#list .grip').getAttribute('aria-pressed')"),
      'false',
      'and it is not picked up until it is',
    );
    // Six dots and a hidden svg: the dots are the picture, the label is the name.
    assert.equal(await look(page, "document.querySelector('#list .grip svg').getAttribute('aria-hidden')"), 'true');
    assert.equal(
      await look(page, "document.querySelector('#list .grip svg').querySelectorAll('circle').length"),
      6,
      'six dots: the picture of a handle',
    );
  });
});

// Requirement: the drag is made of Pointer Events - the only kind a mouse, a finger and a pen all
// speak - and not of HTML5 drag and drop, which a finger cannot start at all. This one is read off the
// two pages themselves, because a build that still carries the old copy is the bug.
test('the drag is pointer events, and there is no HTML5 drag and drop in it', (t) => {
  for (const [what, file] of [
    ['the page in src', SOURCE],
    ['the built page', BUILT],
  ]) {
    if (!existsSync(file)) {
      t.skip('dist/ is only there after `npm run build`');
      return;
    }
    const page = readFileSync(file, 'utf8');
    for (const event of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel']) {
      assert.match(page, new RegExp(`addEventListener\\('${event}'`), `${what} listens for ${event}`);
    }
    assert.match(page, /setPointerCapture\(/, `${what} captures the pointer it took`);
    assert.doesNotMatch(page, /draggable/, `${what} must not lean on HTML5 drag and drop`);
    assert.doesNotMatch(
      page,
      /addEventListener\('drag(start|end|over)?'/,
      `${what} must not listen for a drag event`,
    );
    assert.match(page, /touch-action: none/, `${what} keeps a finger on the handle from scrolling`);
  }
});

// Requirement: a drag is drawing, and the drop is one write. The stub counts: nothing reaches the node
// while the row is in the air, and the let-go is a single `move` naming the neighbour next door.
test('a drag drops the row with one move, and writes nothing while it is in the air', async (t) => {
  await withPage(t, { width: 900 }, async (page, served) => {
    await dragByMouse(page, 3, 2, async () => {
      assert.equal(
        await look(page, "document.querySelector('.row[data-id=\"3\"]').classList.contains('dragging')"),
        true,
        'the row under the hand is lifted',
      );
      assert.equal(
        await look(page, 'getComputedStyle(document.body).cursor'),
        'grabbing',
        'and the page says the hand is holding something',
      );
      const lifted = await look(
        page,
        "(() => { const row = document.querySelector('.row[data-id=\"3\"]'); const style = getComputedStyle(row); return { shadow: style.boxShadow, opacity: Number(style.opacity), transform: row.style.transform }; })()",
      );
      assert.notEqual(lifted.shadow, 'none', 'the lifted row is drawn off the floor, with a shadow');
      assert.ok(lifted.opacity < 1, `and slightly see-through: ${lifted.opacity}`);
      assert.match(lifted.transform, /^translateY\(-?\d+px\)$/, 'while it follows the pointer');
      assert.match(
        await look(page, "document.querySelector('.row[data-id=\"2\"]').style.transform"),
        /^translateY\(-\d+px\)$/,
        'and the row it passed has moved up to close the gap it left',
      );
      assert.deepEqual(served.moves, [], 'a frame of a drag is not a write');
    });
    await until(page, `${ORDER} === '2,3,1'`, 'the dragged row to land');
    assert.deepEqual(
      served.moves,
      [{ id: 3, before: 1 }],
      'one move: the row below it names the place, and nothing else was sent',
    );
    assert.equal(
      served.calls.filter((one) => one.tool === 'todo.move').length,
      1,
      'the node heard about the drop once',
    );
    assert.equal(
      await look(page, "document.querySelector('.row[data-id=\"3\"]').classList.contains('dragging')"),
      false,
      'and the row is on the floor again',
    );
    assert.equal(
      await look(page, "document.querySelector('.row[data-id=\"3\"]').style.transform"),
      '',
      'with no transform left behind',
    );
  });
});

// Requirement: a move that fails puts the row back where it was and says so - an order the node never
// agreed to must not stay on screen.
test('a refused move puts the row back and says could not move', async (t) => {
  await withPage(t, { width: 900 }, async (page, served) => {
    served.refuse(true);
    await dragByMouse(page, 3, 2);
    await until(
      page,
      "document.getElementById('todayResult').textContent.startsWith('could not move:')",
      'the error line',
    );
    assert.equal(
      await look(page, "document.getElementById('todayResult').textContent"),
      'could not move: the store is not writable',
      'the line is English and names what the node said',
    );
    assert.equal(await look(page, ORDER), '3,2,1', 'the row went back where it was');
    assert.deepEqual(served.moves, [{ id: 3, before: 1 }], 'one move was tried, and that was the end of it');
    assert.equal(
      await look(page, "document.querySelector('.row[data-id=\"3\"]').classList.contains('dragging')"),
      false,
      'and it is no longer lifted',
    );
  });
});

// Requirement: the handle is reachable by keyboard and does the same thing - Space picks the row up,
// the arrows walk it one place, Enter drops it with the same single move - and Esc puts it back.
test('a keyboard lifts with Space, walks with the arrows and drops with Enter', async (t) => {
  await withPage(t, { width: 900 }, async (page, served) => {
    await look(page, "document.querySelector('.row[data-id=\"3\"] .grip').focus()");
    await press(page, ' ');
    assert.equal(
      await look(page, "document.activeElement.getAttribute('aria-pressed')"),
      'true',
      'Space picks the row up, and the handle says so',
    );
    await press(page, 'ArrowDown');
    assert.equal(await look(page, ORDER), '2,3,1', 'the arrow walks it one place');
    assert.deepEqual(served.moves, [], 'and the walk is not a write');
    await press(page, 'Enter');
    await until(
      page,
      "document.activeElement.classList.contains('grip') && document.activeElement.getAttribute('aria-pressed') === 'false'",
      'the drop, with the focus back on the handle',
    );
    assert.equal(await look(page, ORDER), '2,3,1', 'the list is the one the node agreed to');
    assert.deepEqual(served.moves, [{ id: 3, before: 1 }], 'Enter is one move, the same one a drop makes');
  });
});

// Requirement: Esc is the way out. A lifted row goes back where it was, and nothing is written.
test('Esc puts a lifted row back without writing anything', async (t) => {
  await withPage(t, { width: 900 }, async (page, served) => {
    await look(page, "document.querySelector('.row[data-id=\"3\"] .grip').focus()");
    await press(page, ' ');
    await press(page, 'ArrowDown');
    await press(page, 'ArrowDown');
    assert.equal(await look(page, ORDER), '2,1,3', 'the row walked to the end of its group');
    await press(page, 'Escape');
    assert.equal(await look(page, ORDER), '3,2,1', 'Esc puts it back where it came from');
    assert.deepEqual(served.moves, [], 'and nothing was written');
    assert.equal(
      await look(page, "document.querySelector('.row[data-id=\"3\"]').classList.contains('dragging')"),
      false,
      'the row is on the floor again',
    );
  });
});

// Requirement: a finger drags it too. The listener is a pointer listener, so touch input arrives as the
// same events a mouse sends - this is the test that says so out loud, with the browser's own touch.
test('a finger drags the same handle', async (t) => {
  await withPage(t, { width: 390, touch: true }, async (page, served) => {
    const spots = await look(
      page,
      "(() => {" +
        " const held = document.querySelector('.row[data-id=\"3\"] .grip').getBoundingClientRect();" +
        " const other = document.querySelector('.row[data-id=\"2\"]').getBoundingClientRect();" +
        ' return {' +
        ' x: Math.round(held.left + held.width / 2),' +
        ' y: Math.round(held.top + held.height / 2),' +
        ' to: Math.round(other.top + other.height / 2),' +
        ' };' +
        ' })()',
    );
    const touch = (type, y) =>
      page.send('Input.dispatchTouchEvent', {
        type,
        touchPoints: type === 'touchEnd' ? [] : [{ x: spots.x, y, id: 1 }],
      });
    await touch('touchStart', spots.y);
    await touch('touchMove', spots.y + 6);
    await touch('touchMove', spots.to + 6);
    assert.equal(
      await look(page, "document.querySelector('.row[data-id=\"3\"]').classList.contains('dragging')"),
      true,
      'the finger is holding the row, and it left the 44px handle under it',
    );
    await touch('touchEnd', spots.to + 6);
    await until(page, `${ORDER} === '2,3,1'`, 'the finger to drop the row');
    assert.deepEqual(served.moves, [{ id: 3, before: 1 }], 'one move, from a finger');
  });
});

// Requirement: a drag goes both ways. The one above drags a row down the list; this one drags the last
// row up, past the middle of the one above it, and the rows it passes make way downwards.
test('a row drags up the list as well as down', async (t) => {
  await withPage(t, { width: 900 }, async (page, served) => {
    const box = await look(
      page,
      "(() => {" +
        " const held = document.querySelector('.row[data-id=\"1\"] .grip').getBoundingClientRect();" +
        " const other = document.querySelector('.row[data-id=\"2\"]').getBoundingClientRect();" +
        ' return {' +
        ' x: Math.round(held.left + held.width / 2),' +
        ' y: Math.round(held.top + held.height / 2),' +
        ' to: Math.round(other.top + 2),' +
        ' };' +
        ' })()',
    );
    await mouse(page, 'mousePressed', box.x, box.y);
    await mouse(page, 'mouseMoved', box.x, box.y - 6);
    await mouse(page, 'mouseMoved', box.x, box.to);
    assert.match(
      await look(page, "document.querySelector('.row[data-id=\"2\"]').style.transform"),
      /^translateY\(\d+px\)$/,
      'the row it is passing has moved down out of its way',
    );
    await mouse(page, 'mouseReleased', box.x, box.to);
    await until(page, `${ORDER} === '3,1,2'`, 'the row to land above its neighbour');
    assert.deepEqual(served.moves, [{ id: 1, before: 2 }], 'one move, naming the row now below it');
  });
});
