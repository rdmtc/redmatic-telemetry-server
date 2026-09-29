// RedMatic Usage Statistics: fetches /data and draws it as inline SVG. No library, nothing from another origin.
// Every value comes from a client: it is only ever set as text (textContent, SVG text nodes), never as HTML.

const TIMESPANS = [1, 7, 30, 90, 365, 36500];
const DEFAULT_TIMESPAN = 365;
const TOP = 10;
const NODES_SHOWN = 50;

const FAMILIES = {
    ccu3: 'CCU3',
    openccu: 'OpenCCU / RaspberryMatic',
    pivccu3: 'piVCCU3',
    lite: 'openccu-lite',
    other: 'other',
};

const SVG_NS = 'http://www.w3.org/2000/svg';
const numberFormat = new Intl.NumberFormat('en');

let current = null;

// ---- small DOM helpers ---------------------------------------------------------------------------------------------

function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
        node.setAttribute(key, value);
    }
    for (const child of children) {
        node.append(child);
    }
    return node;
}

function svgEl(tag, attrs = {}, text) {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [key, value] of Object.entries(attrs)) {
        node.setAttribute(key, value);
    }
    if (text !== undefined) {
        node.textContent = text;
    }
    return node;
}

const fmt = (n) => numberFormat.format(n);

function share(count, total) {
    if (!total) {
        return '0%';
    }
    const p = (100 * count) / total;
    return p > 0 && p < 1 ? '<1%' : Math.round(p) + '%';
}

const shown = (value) => (value === null || value === undefined || value === '' ? '(none)' : String(value));

// ---- versions ------------------------------------------------------------------------------------------------------

function compareVersions(a, b) {
    const parse = (v) => {
        const [main, ...pre] = String(v || '').split('-');
        return {nums: main.split('.').map((n) => parseInt(n, 10) || 0), pre: pre.join('-')};
    };
    const x = parse(a);
    const y = parse(b);
    for (let i = 0; i < Math.max(x.nums.length, y.nums.length); i++) {
        const d = (x.nums[i] || 0) - (y.nums[i] || 0);
        if (d) {
            return d;
        }
    }
    if (x.pre === y.pre) {
        return 0;
    }
    if (!x.pre) {
        return 1;
    }
    if (!y.pre) {
        return -1;
    }
    return x.pre.localeCompare(y.pre, 'en', {numeric: true});
}

const majorMinor = (v) => {
    const m = /^(\d+)\.(\d+)/.exec(String(v || ''));
    return m ? m[1] + '.' + m[2] : shown(v);
};

/** Sums [value, count, extra] rows by key(value); returns [key, count, extra] sorted by version, newest first. */
function groupVersions(rows) {
    const groups = new Map();
    for (const [value, count, extra = 0] of rows) {
        const key = majorMinor(value);
        const g = groups.get(key) || [key, 0, 0];
        g[1] += count;
        g[2] += extra || 0;
        groups.set(key, g);
    }
    return [...groups.values()].sort((a, b) => compareVersions(b[0], a[0]));
}

function flag(cc) {
    const code = String(cc || '')
        .toUpperCase()
        .replace('UK', 'GB');
    if (!/^[A-Z]{2}$/.test(code)) {
        return '';
    }
    return String.fromCodePoint(...[...code].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65)) + ' ';
}

// ---- tooltip -------------------------------------------------------------------------------------------------------

function initTooltip() {
    const tip = document.getElementById('tooltip');
    const show = (event) => {
        const target = event.target.closest && event.target.closest('[data-tip]');
        if (!target) {
            tip.hidden = true;
            return;
        }
        tip.textContent = target.getAttribute('data-tip');
        tip.hidden = false;
        const x = Math.min(event.clientX + 14, window.innerWidth - tip.offsetWidth - 8);
        const y = Math.min(event.clientY + 14, window.innerHeight - tip.offsetHeight - 8);
        tip.style.left = Math.max(8, x) + 'px';
        tip.style.top = Math.max(8, y) + 'px';
    };
    document.addEventListener('pointermove', show);
    document.addEventListener('pointerdown', show);
    document.addEventListener('scroll', () => (tip.hidden = true), {passive: true});
}

// ---- charts --------------------------------------------------------------------------------------------------------

/** Top n by count plus one "other" row. */
function topWithOther(rows, n = TOP) {
    const sorted = [...rows].sort((a, b) => b[1] - a[1]);
    if (sorted.length <= n + 1) {
        return sorted.map(([label, count]) => ({label, count}));
    }
    const top = sorted.slice(0, n).map(([label, count]) => ({label, count}));
    const rest = sorted.slice(n);
    top.push({
        label: rest.length + ' others',
        count: rest.reduce((sum, r) => sum + r[1], 0),
        other: true,
    });
    return top;
}

function truncate(text, max) {
    return text.length > max ? text.slice(0, max - 1) + '…' : text;
}

/**
 * A horizontal bar chart: the top 10 by count and "other", count and share at each bar, and the full list as a table
 * in <details> (also the accessible version).
 */
function barChart(container, rows, {total, labelOf = shown, title, columns = [], tableRows = rows}) {
    container.replaceChildren();
    if (!rows.length) {
        container.append(el('p', {class: 'empty'}, 'No data in this timespan.'));
        return;
    }
    const items = topWithOther(rows).map((item) => ({...item, text: item.other ? item.label : labelOf(item.label)}));
    const width = Math.max(260, container.clientWidth);
    const rowHeight = 26;
    const barHeight = 16;
    const labelWidth = Math.min(200, Math.round(width * 0.38));
    const valueWidth = 96;
    const plotWidth = Math.max(40, width - labelWidth - valueWidth);
    const max = Math.max(...items.map((i) => i.count));
    const height = items.length * rowHeight;
    const maxChars = Math.floor(labelWidth / 7);

    const svg = svgEl('svg', {
        width,
        height,
        viewBox: `0 0 ${width} ${height}`,
        role: 'img',
        'aria-label': title + ': ' + items.map((i) => `${i.text} ${fmt(i.count)}`).join(', '),
    });
    items.forEach((item, i) => {
        const y = i * rowHeight;
        const w = Math.max(2, Math.round((item.count / max) * plotWidth));
        const tip = `${item.text}: ${fmt(item.count)} (${share(item.count, total)})`;
        const group = svgEl('g', {'data-tip': tip});
        group.append(svgEl('rect', {class: 'hit', x: 0, y, width, height: rowHeight}));
        group.append(
            svgEl(
                'text',
                {class: 'label', x: labelWidth - 8, y: y + rowHeight / 2 + 4, 'text-anchor': 'end'},
                truncate(item.text, maxChars),
            ),
        );
        group.append(
            svgEl('rect', {
                class: 'bar' + (item.other ? ' other' : ''),
                x: labelWidth,
                y: y + (rowHeight - barHeight) / 2,
                width: w,
                height: barHeight,
                rx: 3,
            }),
        );
        group.append(
            svgEl(
                'text',
                {x: labelWidth + w + 6, y: y + rowHeight / 2 + 4},
                `${fmt(item.count)} · ${share(item.count, total)}`,
            ),
        );
        svg.append(group);
    });
    container.append(svg);
    container.append(table(tableRows, {total, labelOf, columns, summary: `All ${fmt(tableRows.length)} as a table`}));
}

function table(rows, {total, labelOf = shown, columns = [], summary, limit}) {
    const head = el(
        'tr',
        {},
        el('th', {scope: 'col'}, 'Value'),
        el('th', {scope: 'col', class: 'num'}, 'Installations'),
        el('th', {scope: 'col', class: 'num'}, 'Share'),
        ...columns.map((c) => el('th', {scope: 'col', class: 'num'}, c.title)),
    );
    const body = el('tbody');
    for (const row of limit ? rows.slice(0, limit) : rows) {
        body.append(
            el(
                'tr',
                {},
                el('td', {}, labelOf(row[0])),
                el('td', {class: 'num'}, fmt(row[1])),
                el('td', {class: 'num'}, share(row[1], total)),
                ...columns.map((c) => el('td', {class: 'num'}, c.value(row))),
            ),
        );
    }
    const t = el('table', {}, el('thead', {}, head), body);
    return summary ? el('details', {}, el('summary', {}, summary), t) : t;
}

/** Buckets for the new-installations chart: hours up to 7 days, days up to 90, weeks for 365, months for all. */
function buckets(byday, timespan) {
    const now = Date.now();
    let unit;
    if (timespan <= 7) {
        unit = 'hour';
    } else if (timespan <= 90) {
        unit = 'day';
    } else if (timespan <= 365) {
        unit = 'week';
    } else {
        unit = 'month';
    }
    const start = (t) => {
        const d = new Date(t);
        if (unit === 'hour') {
            d.setMinutes(0, 0, 0);
        } else {
            d.setHours(0, 0, 0, 0);
            if (unit === 'week') {
                d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
            } else if (unit === 'month') {
                d.setDate(1);
            }
        }
        return d.getTime();
    };
    const next = (t) => {
        const d = new Date(t);
        if (unit === 'hour') {
            d.setHours(d.getHours() + 1);
        } else if (unit === 'day') {
            d.setDate(d.getDate() + 1);
        } else if (unit === 'week') {
            d.setDate(d.getDate() + 7);
        } else {
            d.setMonth(d.getMonth() + 1);
        }
        return d.getTime();
    };
    const first = timespan >= 36500 ? (byday.length ? byday[0][0] : now) : now - timespan * 86400000;
    const list = [];
    const index = new Map();
    for (let t = start(first); t <= now; t = next(t)) {
        index.set(t, list.length);
        list.push([t, 0]);
    }
    for (const [t, count] of byday) {
        const i = index.get(start(t));
        if (i !== undefined) {
            list[i][1] += count;
        }
    }
    return {unit, list};
}

function bucketLabel(t, unit, long) {
    const d = new Date(t);
    if (unit === 'hour') {
        return d.toLocaleString('en', {weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false});
    }
    if (unit === 'month') {
        return d.toLocaleDateString('en', {year: 'numeric', month: long ? 'long' : 'short'});
    }
    const date = d.toLocaleDateString('en', {year: 'numeric', month: 'short', day: 'numeric'});
    return unit === 'week' && long ? 'week of ' + date : date;
}

function niceStep(max, ticks = 4) {
    const raw = max / ticks;
    const magnitude = Math.pow(10, Math.floor(Math.log10(raw || 1)));
    const n = raw / magnitude;
    return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * magnitude;
}

function columnChart(container, byday, timespan) {
    container.replaceChildren();
    const {unit, list} = buckets(byday, timespan);
    const total = list.reduce((sum, b) => sum + b[1], 0);
    if (!total) {
        container.append(el('p', {class: 'empty'}, 'No new installations in this timespan.'));
        return;
    }
    const width = Math.max(260, container.clientWidth);
    const height = 200;
    const left = 44;
    const bottom = 24;
    const top = 8;
    const plotWidth = width - left - 4;
    const plotHeight = height - bottom - top;
    const max = Math.max(...list.map((b) => b[1]));
    const step = Math.max(1, niceStep(max));
    const yMax = Math.ceil(max / step) * step;
    const slot = plotWidth / list.length;
    const gap = slot > 6 ? 2 : slot > 3 ? 1 : 0;

    const svg = svgEl('svg', {
        width,
        height,
        viewBox: `0 0 ${width} ${height}`,
        role: 'img',
        'aria-label': `New installations per ${unit}: ${fmt(total)} in all, at most ${fmt(max)} per ${unit}`,
    });
    for (let v = 0; v <= yMax; v += step) {
        const y = top + plotHeight - (v / yMax) * plotHeight;
        svg.append(svgEl('line', {class: v ? 'gridline' : 'axis', x1: left, x2: width - 4, y1: y, y2: y}));
        svg.append(svgEl('text', {x: left - 6, y: y + 4, 'text-anchor': 'end'}, fmt(v)));
    }
    list.forEach(([t, count], i) => {
        const x = left + i * slot;
        const h = (count / yMax) * plotHeight;
        const group = svgEl('g', {'data-tip': `${bucketLabel(t, unit, true)}: ${fmt(count)} new`});
        group.append(svgEl('rect', {class: 'hit', x, y: top, width: slot, height: plotHeight}));
        if (count) {
            group.append(
                svgEl('rect', {
                    class: 'bar',
                    x: x + gap / 2,
                    y: top + plotHeight - h,
                    width: Math.max(1, slot - gap),
                    height: Math.max(1, h),
                    rx: slot > 8 ? 2 : 0,
                }),
            );
        }
        svg.append(group);
    });
    // x labels: first, middle and last; on a narrow screen first and last only
    const middle = width >= 480 ? [Math.floor((list.length - 1) / 2)] : [];
    const labels = [...new Set([0, ...middle, list.length - 1])];
    labels.forEach((i, n) => {
        const anchor = n === 0 ? 'start' : n === labels.length - 1 ? 'end' : 'middle';
        const x = n === 0 ? left : n === labels.length - 1 ? width - 4 : left + (i + 0.5) * slot;
        svg.append(svgEl('text', {x, y: height - 6, 'text-anchor': anchor}, bucketLabel(list[i][0], unit, false)));
    });
    container.append(svg);
    const rows = list.filter((b) => b[1]).map(([t, count]) => [bucketLabel(t, unit, true), count]);
    container.append(
        table(rows.reverse(), {
            total,
            labelOf: String,
            summary: `Per ${unit} as a table`,
        }),
    );
}

// ---- the page ------------------------------------------------------------------------------------------------------

function renderNodes(data) {
    const container = document.getElementById('nodes');
    const filter = document.getElementById('nodes-filter').value.trim().toLowerCase();
    const rows = filter ? data.nodes.filter(([name]) => name.toLowerCase().includes(filter)) : data.nodes;
    container.replaceChildren();
    if (!rows.length) {
        container.append(el('p', {class: 'empty'}, filter ? 'No node matches.' : 'No data in this timespan.'));
        return;
    }
    container.append(table(rows, {total: data.total, labelOf: String, limit: NODES_SHOWN}));
    if (rows.length > NODES_SHOWN) {
        container.append(
            el('p', {class: 'more'}, `The top ${NODES_SHOWN} of ${fmt(rows.length)}. Filter to find the others.`),
        );
    }
}

function render(data, timespan) {
    const total = data.total || 0;
    const byId = (id) => document.getElementById(id);

    byId('tile-total').textContent = fmt(total);
    byId('tile-new').textContent = fmt(data.byday.reduce((sum, b) => sum + b[1], 0));
    const newest = data.versions.find(([v]) => v && !String(v).includes('-'));
    byId('tile-newest').textContent = newest ? share(newest[1], total) : '–';
    byId('tile-newest-note').textContent = newest ? `run RedMatic ${newest[0]}` : '';
    const families = data.families || [];
    const lite = (families.find(([f]) => f === 'lite') || [null, 0])[1];
    byId('tile-lite').textContent = fmt(lite);
    byId('tile-lite-note').textContent = `${share(lite, total)} of the installations`;

    columnChart(byId('chart-new'), data.byday, timespan);

    barChart(byId('chart-redmatic'), groupVersions(data.versions), {
        total,
        title: 'RedMatic versions',
        tableRows: data.versions,
    });
    barChart(byId('chart-family'), families, {
        total,
        title: 'Firmware family',
        labelOf: (f) => FAMILIES[f] || shown(f),
    });
    // a lite system reports its OpenCCU base version: the table says how many of each are openccu-lite
    barChart(byId('chart-ccu'), groupVersions(data.ccuVersions), {
        total,
        title: 'CCU versions',
        tableRows: data.ccuVersions,
        columns: [{title: 'of them openccu-lite', value: (row) => (row[2] ? fmt(row[2]) : '')}],
    });
    barChart(byId('chart-product'), data.products, {total, title: 'CCU products'});
    barChart(byId('chart-platform'), data.platforms, {total, title: 'CCU platforms'});
    barChart(byId('chart-lite'), data.liteVersions || [], {total, title: 'openccu-lite versions'});
    const countries = data.countries.map(([cc, name, count]) => [cc, count, name]);
    const countryName = new Map(data.countries.map(([cc, name]) => [cc, name]));
    barChart(byId('chart-country'), countries, {
        total,
        title: 'Countries',
        labelOf: (cc) => {
            const name = countryName.get(cc);
            return !cc || cc === '-' || cc === '--' || !name || name === '-' ? 'unknown' : flag(cc) + name;
        },
    });
    renderNodes(data);
}

function selected() {
    const t = parseInt(location.hash.slice(1), 10);
    return TIMESPANS.includes(t) ? t : DEFAULT_TIMESPAN;
}

async function load() {
    const timespan = selected();
    for (const button of document.querySelectorAll('[data-timespan]')) {
        button.setAttribute('aria-pressed', String(Number(button.dataset.timespan) === timespan));
    }
    const status = document.getElementById('status');
    status.textContent = 'Loading…';
    try {
        const res = await fetch('data?timespan=' + timespan);
        if (!res.ok) {
            throw new Error(res.status + ' ' + res.statusText);
        }
        current = {data: await res.json(), timespan};
        status.textContent = '';
        render(current.data, current.timespan);
    } catch (err) {
        status.textContent = 'The statistics could not be loaded: ' + err.message;
    }
}

function init() {
    initTooltip();
    for (const button of document.querySelectorAll('[data-timespan]')) {
        button.addEventListener('click', () => {
            location.hash = '#' + button.dataset.timespan;
        });
    }
    window.addEventListener('hashchange', load);
    document.getElementById('nodes-filter').addEventListener('input', () => current && renderNodes(current.data));
    let width = document.querySelector('main').clientWidth;
    let timer;
    new ResizeObserver(() => {
        const w = document.querySelector('main').clientWidth;
        if (w === width || !current) {
            return;
        }
        width = w;
        clearTimeout(timer);
        timer = setTimeout(() => render(current.data, current.timespan), 100);
    }).observe(document.querySelector('main'));
    load();
}

init();
