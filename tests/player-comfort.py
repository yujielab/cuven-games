"""Browser regression checks. Run: python tests/player-comfort.py
Requires Node.js, Python playwright, and Chromium (CHROMIUM_PATH can override).
Uses the repository's card metadata; never creates rooms or contacts live services.
"""
import functools
import http.server
import json
import os
from pathlib import Path
import subprocess
import threading
import tempfile
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
fixture = subprocess.check_output(['node', '-e', '''
const fs = require('fs'), vm = require('vm');
const source = fs.readFileSync('monopoly-deal-worker.js', 'utf8')
  .split('export default {')[0].replace(/^import .*$/m, '');
const context = { console, URL, TextEncoder, TextDecoder, Response, Request,
  Headers, crypto, setTimeout, clearTimeout };
vm.runInNewContext(source + ';result=META_JSON;', context);
process.stdout.write(context.result);
'''], cwd=ROOT).decode()

class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass

server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(QuietHandler, directory=str(ROOT)))
threading.Thread(target=server.serve_forever, daemon=True).start()
url = f'http://127.0.0.1:{server.server_port}/monopoly-deal.html?debug=1'

with sync_playwright() as pw:
    browser = pw.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH', '/usr/bin/chromium'), args=['--no-sandbox'])
    context = browser.new_context(viewport={'width': 390, 'height': 844}, is_mobile=True, has_touch=True)
    page = context.new_page()
    errors = []
    page.on('pageerror', lambda e: errors.append(str(e)))
    def route(request):
        if request.request.url.startswith(f'http://127.0.0.1:{server.server_port}'):
            request.continue_()
        elif request.request.url.endswith('/api/meta'):
            request.fulfill(json=json.loads(fixture))
        else:
            request.abort()
    context.route('**/*', route)
    page.add_init_script('''
      window.__vibrations = 0; window.__gainTargets = [];
      Object.defineProperty(navigator, 'vibrate', { value: () => { window.__vibrations++; return true; } });
      const original = AudioParam.prototype.setTargetAtTime;
      AudioParam.prototype.setTargetAtTime = function(value, ...args) {
        window.__gainTargets.push(value); return original.call(this, value, ...args);
      };
    ''')
    page.goto(url)
    page.get_by_role('button', name='体验设置', exact=True).click()
    dialog = page.get_by_role('dialog', name='体验设置')
    dialog.wait_for(state='visible')
    assert page.locator('#screen').evaluate('(el) => el.inert')
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
    page.get_by_role('switch', name='减少动态效果').click()
    assert page.evaluate('!window.__md.motionOK()')
    assert page.locator('html').evaluate('(el) => el.classList.contains("reduce-motion")')
    assert page.evaluate('document.activeElement.dataset.do') == 'reduced-motion'
    assert float(page.locator('.menu button').first.evaluate('(el) => parseFloat(getComputedStyle(el).transitionDuration)')) < .001
    page.get_by_role('switch', name='触感反馈').click()
    assert page.evaluate('window.__vibrations') == 0
    volume = page.get_by_role('slider', name='音效音量')
    volume.fill('35')
    assert page.locator('#volume-value').inner_text() == '35%'
    assert page.evaluate('JSON.parse(localStorage.getItem("md.volume"))') == 35
    assert abs(page.evaluate('window.__gainTargets.at(-1)') - .077) < .0001
    page.get_by_role('switch', name='游戏音效').click()
    assert volume.is_disabled()
    assert page.evaluate('window.__gainTargets.at(-1)') == 0
    assert page.evaluate('document.activeElement.dataset.do') == 'sound'
    # Focus stays within the dialog in both directions.
    page.get_by_role('button', name='完成', exact=True).focus()
    page.keyboard.press('Tab')
    assert page.evaluate('document.activeElement.dataset.do') == 'sound'
    page.keyboard.press('Shift+Tab')
    assert page.evaluate('document.activeElement.dataset.do') == 'close-sheet'
    page.keyboard.press('Escape')
    assert not page.locator('#screen').evaluate('(el) => el.inert')
    assert page.evaluate('document.activeElement.dataset.do') == 'comfort'
    assert page.locator('#sheet-root').evaluate('(el) => el.inert')
    page.reload()
    page.get_by_role('button', name='体验设置', exact=True).click()
    assert page.get_by_role('switch', name='减少动态效果').get_attribute('aria-checked') == 'true'
    assert page.get_by_role('switch', name='触感反馈').get_attribute('aria-checked') == 'false'
    assert page.get_by_role('switch', name='游戏音效').get_attribute('aria-checked') == 'false'
    assert volume.input_value() == '35'
    page.get_by_role('switch', name='游戏音效').click()
    # Background tabs mute the existing audio bus immediately.
    page.evaluate('Object.defineProperty(document, "hidden", {configurable:true, value:true}); document.dispatchEvent(new Event("visibilitychange"))')
    assert page.evaluate('window.__gainTargets.at(-1)') == 0
    page.evaluate('Object.defineProperty(document, "hidden", {configurable:true, value:false}); document.dispatchEvent(new Event("visibilitychange"))')
    assert abs(page.evaluate('window.__gainTargets.at(-1)') - .077) < .0001
    # Follow the system even when the manual switch is off.
    page.get_by_role('switch', name='减少动态效果').click()
    assert page.evaluate('window.__md.motionOK()')
    page.emulate_media(reduced_motion='reduce')
    page.wait_for_function('!window.__md.motionOK() && document.documentElement.classList.contains("reduce-motion")')
    # Screenshots at mobile and desktop sizes for layout review.
    out = Path(os.environ.get('COMFORT_SCREENSHOTS', tempfile.mkdtemp(prefix='player-comfort-')))
    out.mkdir(parents=True, exist_ok=True)
    page.screenshot(path=str(out / 'comfort-mobile.png'))
    page.set_viewport_size({'width': 1280, 'height': 800})
    page.screenshot(path=str(out / 'comfort-desktop.png'))
    page.keyboard.press('Escape')
    page.locator('#name').fill('小明')
    calls = []
    page.on('request', lambda r: calls.append(r.url) if '/api/rooms' in r.url else None)
    page.locator('#name').evaluate('(el) => el.dispatchEvent(new KeyboardEvent("keydown", {key:"Enter", isComposing:true, bubbles:true}))')
    page.locator('#code').evaluate('(el) => el.dispatchEvent(new KeyboardEvent("keydown", {key:"Enter", keyCode:229, bubbles:true}))')
    assert not calls
    assert not errors, errors
    # Storage-denied browsers still reach the home page.
    private = context.new_page()
    private_errors = []
    private.on('pageerror', lambda e: private_errors.append(str(e)))
    private.add_init_script('Object.defineProperty(window, "localStorage", {get() {throw new DOMException("Denied", "SecurityError")}})')
    private.goto(url)
    private.get_by_role('button', name='体验设置', exact=True).click()
    private.get_by_role('dialog', name='体验设置').wait_for(state='visible')
    assert not private_errors, private_errors
    browser.close()
server.shutdown()
print('PASS: mobile/desktop layout, persistence, volume/mute, background audio, reduced motion, haptics, dialog focus, IME, blocked storage')
