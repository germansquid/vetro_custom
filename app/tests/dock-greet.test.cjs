'use strict';
// The greeting app (greetApp): with the Vetro launcher on the Home key, one chosen app is opened once whenever the TV
// was off and is turned on with the power key — a cold boot, or a wake from standby — but never on a screensaver dismiss.
const assert = require('assert').strict;
const fs = require('fs');
const os = require('os');
const path = require('path');
const {Dock} = require('../service/dock.js');

const GREET = 'Arn0Lnchr0.Launcher';

// Decodes the wrapped shell a command carries (echo <base64> | base64 -d | sh), or returns it unwrapped.
function decode(cmd) {
    return /^echo \S+ \| base64 -d \| sh$/.test(cmd) ? Buffer.from(cmd.split(' ')[1], 'base64').toString() : cmd;
}

function fixture(options) {
    options = options || {};
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vetro-dock-greet-'));
    const dir = path.join(tmp, 'dock');
    fs.mkdirSync(path.join(dir, 'res'), {recursive: true});
    fs.writeFileSync(path.join(dir, 'tvlauncher-dotnet.dll'), 'x');
    fs.writeFileSync(path.join(dir, 'res', 'glass_tile.png'), 'x');
    const tv = {clock: 1000000, scripts: [], launched: [], screensaver: false};
    const execute = async function (cmd) {
        tv.scripts.push(cmd);
        const script = decode(cmd);
        // The greeting shell: a screensaver guard, then app_launcher -e (resume) with -s as fallback.
        if (/app_launcher -e /.test(script) && /screensaver_on_off/.test(script)) {
            if (tv.screensaver) return {exit_code: 0, stdout: ''};   // guard exits 0 before launching
            const id = /app_launcher -e (\S+)/.exec(script)[1];
            tv.launched.push(id);
            return {exit_code: 0, stdout: 'greeted\n'};
        }
        return {exit_code: 0, stdout: ''};
    };
    const dock = new Dock({execute, dir, stateFile: path.join(tmp, 'state.json'), appsFile: path.join(tmp, 'apps.tsv'),
        customAppsFile: path.join(tmp, 'custom.tsv'), appCheck: async id => ({ok: true, label: id}),
        now: () => tv.clock, uptime: () => options.uptime !== undefined ? options.uptime : 10,
        serviceStart: options.serviceStart !== undefined ? options.serviceStart : 0});
    return {dock, tv, tmp};
}

(async function () {
    // --- setGreetApp / clearGreetApp: validation and persistence ---
    let f = fixture();
    f.dock.patchState({enabled: true});
    let s = await f.dock.setGreetApp(GREET);
    assert.equal(s.greetApp, GREET, 'status reports the greeting app');
    assert.equal(f.dock.readState().greetApp, GREET, 'it is persisted');
    assert.equal(typeof f.dock.readState().greetSince, 'number');

    await assert.rejects(f.dock.setGreetApp('bad id with spaces'), /list/, 'an invalid id is refused');
    await f.dock.clearGreetApp();
    assert.equal(f.dock.readState().greetApp, null, 'cleared');

    // The greeting app and the custom launcher exclude each other.
    f = fixture();
    f.dock.patchState({customApp: 'com.example.other', enabled: false});
    await assert.rejects(f.dock.setGreetApp(GREET), /custom launcher/);

    // --- showGreetApp: cold boot opens it once ---
    f = fixture({serviceStart: 0, uptime: 20});
    f.dock.patchState({enabled: true, greetApp: GREET});
    await f.dock.showGreetApp(f.dock.readState());
    assert.deepEqual(f.tv.launched, [GREET], 'opened once at cold boot');
    await f.dock.showGreetApp(f.dock.readState());
    assert.deepEqual(f.tv.launched, [GREET], 'not opened a second time in the same run');

    // --- outside the power-on window and with no wake: nothing opens ---
    f = fixture({serviceStart: 1000, uptime: 5000});   // a later restart of the service, long after boot
    f.dock.patchState({enabled: true, greetApp: GREET});
    await f.dock.showGreetApp(f.dock.readState());
    assert.deepEqual(f.tv.launched, [], 'no open without a cold boot or a wake');

    // --- wake from standby opens it once, after the settle delay ---
    f = fixture({serviceStart: 1000, uptime: 5000});
    f.dock.patchState({enabled: true, greetApp: GREET});
    f.dock.noteWake();
    await f.dock.showGreetApp(f.dock.readState());
    assert.deepEqual(f.tv.launched, [], 'not yet: the settle delay has not passed');
    f.tv.clock += 30000;                                // past WAKE_HOME_DELAY_MS (25 s)
    await f.dock.showGreetApp(f.dock.readState());
    assert.deepEqual(f.tv.launched, [GREET], 'opened once the wake has settled');
    await f.dock.showGreetApp(f.dock.readState());
    assert.deepEqual(f.tv.launched, [GREET], 'not opened again for the same wake');

    // --- a screensaver dismiss never opens it: no wake is noted, and the vconf guard is a second line ---
    f = fixture({serviceStart: 1000, uptime: 5000});
    f.dock.patchState({enabled: true, greetApp: GREET});
    await f.dock.showGreetApp(f.dock.readState());   // a plain round, no noteWake()
    assert.deepEqual(f.tv.launched, [], 'a screensaver dismiss (no wake) opens nothing');
    // Even inside a power-on window, the shell guard skips the launch while the screensaver is up.
    f = fixture({serviceStart: 0, uptime: 20});
    f.dock.patchState({enabled: true, greetApp: GREET});
    f.tv.screensaver = true;
    await f.dock.showGreetApp(f.dock.readState());
    assert.deepEqual(f.tv.launched, [], 'the screensaver guard holds the launch');

    // --- it does nothing without the Vetro launcher, or in custom launcher mode ---
    f = fixture({serviceStart: 0, uptime: 20});
    f.dock.patchState({enabled: false, greetApp: GREET});
    await f.dock.showGreetApp(f.dock.readState());
    assert.deepEqual(f.tv.launched, [], 'off when the Vetro launcher is off');
    f = fixture({serviceStart: 0, uptime: 20});
    f.dock.patchState({enabled: true, customApp: 'com.example.other', greetApp: GREET});
    await f.dock.showGreetApp(f.dock.readState());
    assert.deepEqual(f.tv.launched, [], 'off in custom launcher mode');

    console.log('PASS greeting app: set/clear, cold boot once, standby wake once after settle, never on screensaver, launcher-mode only');
})().catch(e => { console.error(e); process.exitCode = 1; });
