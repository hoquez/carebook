// Reference-range parsing and the "View trends" chart for lab results.

const SVG_NS = 'http://www.w3.org/2000/svg';
const COLORS = {
  line: '#3a5a8c',
  out: '#d93b2b',
  reference: '#2f8f5b',
  band: '#2f8f5b1a',
  grid: '#e4e8df',
  text: '#75817a',
  ink: '#1f302b',
  surface: '#fffefa'
};
const MARGIN = { top: 18, right: 78, bottom: 34, left: 48 };
const HEIGHT = 280;

export function numbersIn(text) {
  return (String(text ?? '').match(/\d*\.?\d+/g) ?? []).map(Number);
}

// Reads ranges like "4–10", "4 to 10", "<35", "up to 33" or ">5". Returns null if unreadable.
export function parseRange(text) {
  if (!text) return null;
  const range = String(text).toLowerCase().replace(/[–—]/g, '-').trim();
  const numbers = numbersIn(range);
  if (!numbers.length) return null;
  if (/^(<|≤|up ?to|less than|below)/.test(range)) return { min: -Infinity, max: numbers.at(-1) };
  if (/^(>|≥|more than|above|at least)/.test(range)) return { min: numbers[0], max: Infinity };
  if (numbers.length >= 2 && /\d\s*(-|to)\s*\.?\d/.test(range)) return { min: numbers[0], max: numbers[1] };
  return null;
}

// true = within range, false = outside, null = cannot tell.
export function rangeStatus(result, rangeText) {
  const range = parseRange(rangeText);
  const [value] = numbersIn(result);
  if (!range || value === undefined) return null;
  return value >= range.min && value <= range.max;
}

const dateFormat = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const trendDialog = document.querySelector('#trend-dialog');
const chartElement = document.querySelector('#trend-chart');
let current = null;

function svg(tag, attributes = {}, parent = null) {
  const element = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, value);
  parent?.append(element);
  return element;
}

function niceTicks(low, high, count = 5) {
  const raw = (high - low) / count || 1;
  const power = 10 ** Math.floor(Math.log10(raw));
  const fraction = raw / power;
  const step = (fraction >= 7.5 ? 10 : fraction >= 3.5 ? 5 : fraction >= 1.5 ? 2 : 1) * power;
  const start = Math.floor(low / step) * step;
  const end = Math.ceil(high / step) * step;
  const ticks = [];
  for (let value = start; value <= end + step / 2; value += step) ticks.push(Number(value.toFixed(10)));
  return ticks;
}

function formatNumber(value) {
  return Number(value.toPrecision(6)).toLocaleString();
}

function sameTest(a, b) {
  return String(a ?? '').trim().toLocaleLowerCase() === String(b ?? '').trim().toLocaleLowerCase();
}

function renderChart() {
  const { points, range, unit } = current;
  chartElement.replaceChildren();
  if (!points.length) {
    const empty = document.createElement('p');
    empty.className = 'trend-empty';
    empty.textContent = 'No dated numeric results for this test yet.';
    chartElement.append(empty);
    return;
  }

  const width = Math.max(chartElement.clientWidth, 280);
  const plotWidth = width - MARGIN.left - MARGIN.right;
  const plotHeight = HEIGHT - MARGIN.top - MARGIN.bottom;

  const values = points.map(point => point.value);
  if (range) values.push(...[range.min, range.max].filter(Number.isFinite));
  let low = Math.min(...values);
  let high = Math.max(...values);
  const pad = (high - low) * 0.15 || Math.abs(high) * 0.2 || 1;
  low = low - pad < 0 && low >= 0 ? 0 : low - pad;
  high += pad;
  const ticks = niceTicks(low, high);
  const yMin = ticks[0];
  const yMax = ticks.at(-1);
  const y = value => MARGIN.top + plotHeight - ((value - yMin) / (yMax - yMin)) * plotHeight;

  const times = points.map(point => point.time);
  const tMin = Math.min(...times);
  const tMax = Math.max(...times);
  const inset = 18;
  const x = time => tMax === tMin
    ? MARGIN.left + plotWidth / 2
    : MARGIN.left + inset + ((time - tMin) / (tMax - tMin)) * (plotWidth - inset * 2);

  const root = svg('svg', { width, height: HEIGHT, viewBox: `0 0 ${width} ${HEIGHT}`, role: 'img', 'aria-label': current.label });

  // Gridlines and y-axis labels.
  for (const tick of ticks) {
    svg('line', { x1: MARGIN.left, x2: MARGIN.left + plotWidth, y1: y(tick), y2: y(tick), stroke: COLORS.grid, 'stroke-width': 1 }, root);
    const label = svg('text', { x: MARGIN.left - 8, y: y(tick) + 4, 'text-anchor': 'end', class: 'trend-tick' }, root);
    label.textContent = formatNumber(tick);
  }

  // Reference range: shaded band plus a green line at each end.
  if (range) {
    const top = y(Math.min(range.max, yMax));
    const bottom = y(Math.max(range.min, yMin));
    svg('rect', { x: MARGIN.left, y: top, width: plotWidth, height: Math.max(bottom - top, 0), fill: COLORS.band }, root);
    for (const [bound, name] of [[range.max, 'High'], [range.min, 'Low']]) {
      if (!Number.isFinite(bound)) continue;
      svg('line', { x1: MARGIN.left, x2: MARGIN.left + plotWidth, y1: y(bound), y2: y(bound), stroke: COLORS.reference, 'stroke-width': 2 }, root);
      const label = svg('text', { x: MARGIN.left + plotWidth + 8, y: y(bound) + 4, class: 'trend-ref-label' }, root);
      label.textContent = `${name} ${formatNumber(bound)}`;
    }
  }

  // X-axis date labels: keep at least LABEL_GAP px apart, and always show the latest date.
  const LABEL_GAP = 92;
  const labelled = [];
  for (const point of points) {
    if (!labelled.length || x(point.time) - x(labelled.at(-1).time) >= LABEL_GAP) labelled.push(point);
  }
  const last = points.at(-1);
  if (labelled.at(-1) !== last) {
    if (x(last.time) - x(labelled.at(-1).time) < LABEL_GAP) labelled.pop();
    labelled.push(last);
  }
  for (const point of labelled) {
    const label = svg('text', { x: x(point.time), y: HEIGHT - 10, 'text-anchor': 'middle', class: 'trend-tick' }, root);
    label.textContent = dateFormat.format(point.date);
  }

  // The result line and its points.
  if (points.length > 1) {
    const path = points.map((point, index) => `${index ? 'L' : 'M'}${x(point.time)},${y(point.value)}`).join(' ');
    svg('path', { d: path, fill: 'none', stroke: COLORS.line, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }, root);
  }
  for (const point of points) {
    svg('circle', { cx: x(point.time), cy: y(point.value), r: 5, fill: point.inRange === false ? COLORS.out : COLORS.line, stroke: COLORS.surface, 'stroke-width': 2 }, root);
  }

  // Direct label on the latest value only.
  const latest = points.at(-1);
  const latestLabel = svg('text', { x: x(latest.time), y: y(latest.value) - 12, 'text-anchor': 'middle', class: 'trend-value-label' }, root);
  latestLabel.textContent = formatNumber(latest.value);

  // Hover / touch: a crosshair snaps to the nearest date and a tooltip shows the value.
  const crosshair = svg('line', { y1: MARGIN.top, y2: MARGIN.top + plotHeight, stroke: COLORS.text, 'stroke-width': 1, visibility: 'hidden' }, root);
  const overlay = svg('rect', { x: MARGIN.left, y: MARGIN.top, width: plotWidth, height: plotHeight, fill: 'transparent' }, root);
  const tooltip = document.createElement('div');
  tooltip.className = 'trend-tooltip';
  tooltip.hidden = true;

  const showNearest = event => {
    const box = root.getBoundingClientRect();
    const pointerX = event.clientX - box.left;
    const nearest = points.reduce((best, point) => Math.abs(x(point.time) - pointerX) < Math.abs(x(best.time) - pointerX) ? point : best);
    const px = x(nearest.time);
    crosshair.setAttribute('x1', px);
    crosshair.setAttribute('x2', px);
    crosshair.setAttribute('visibility', 'visible');
    const status = nearest.inRange === null ? '' : nearest.inRange ? 'Within range' : 'Outside range';
    tooltip.replaceChildren();
    const dateLine = document.createElement('strong');
    dateLine.textContent = dateFormat.format(nearest.date);
    const valueLine = document.createElement('span');
    valueLine.textContent = `${nearest.raw}${unit ? ` ${unit}` : ''}`;
    tooltip.append(dateLine, valueLine);
    if (status) {
      const statusLine = document.createElement('span');
      statusLine.className = nearest.inRange ? 'trend-status-in' : 'trend-status-out';
      statusLine.textContent = status;
      tooltip.append(statusLine);
    }
    tooltip.hidden = false;
    const left = Math.min(Math.max(px - tooltip.offsetWidth / 2, 0), width - tooltip.offsetWidth);
    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${Math.max(y(nearest.value) - tooltip.offsetHeight - 16, 0)}px`;
  };
  const hide = () => {
    crosshair.setAttribute('visibility', 'hidden');
    tooltip.hidden = true;
  };
  overlay.addEventListener('pointermove', showNearest);
  overlay.addEventListener('pointerdown', showNearest);
  overlay.addEventListener('pointerleave', hide);

  chartElement.append(root, tooltip);
}

function renderTable() {
  const body = document.querySelector('#trend-table-body');
  body.replaceChildren();
  for (const point of [...current.points].reverse()) {
    const row = document.createElement('tr');
    const status = point.inRange === null ? '—' : point.inRange ? 'Within range' : 'Outside range';
    for (const text of [dateFormat.format(point.date), `${point.raw}${current.unit ? ` ${current.unit}` : ''}`, point.rangeText ?? '—', status]) {
      const cell = document.createElement('td');
      cell.textContent = text;
      row.append(cell);
    }
    body.append(row);
  }
}

export function openTrends(allRecords, record) {
  const matching = allRecords.filter(item => sameTest(item.test_name, record.test_name));
  const points = matching
    .filter(item => item.test_date && numbersIn(item.result).length)
    .map(item => {
      const date = new Date(`${item.test_date}T00:00:00Z`);
      return {
        date,
        time: date.getTime(),
        value: numbersIn(item.result)[0],
        raw: String(item.result).trim(),
        rangeText: item.reference_range,
        inRange: rangeStatus(item.result, item.reference_range)
      };
    })
    .sort((a, b) => a.time - b.time);

  const rangeText = [...points].reverse().find(point => point.rangeText)?.rangeText ?? record.reference_range;
  const unit = [...matching].reverse().find(item => item.unit)?.unit ?? record.unit ?? '';
  current = {
    points,
    range: parseRange(rangeText),
    unit,
    label: `${record.test_name} results over time`
  };

  document.querySelector('#trend-title').textContent = record.test_name;
  const summary = [];
  if (points.length) {
    const latest = points.at(-1);
    summary.push(`Latest: ${latest.raw}${unit ? ` ${unit}` : ''} on ${dateFormat.format(latest.date)}.`);
  }
  if (rangeText) summary.push(`Reference range: ${rangeText}${unit ? ` ${unit}` : ''} (green lines).`);
  if (points.length === 1) summary.push('Only one dated result so far; the trend line appears after the next test.');
  const undated = matching.length - points.length;
  if (undated > 0) summary.push(`${undated} result${undated === 1 ? '' : 's'} without a test date or number ${undated === 1 ? 'is' : 'are'} not shown.`);
  document.querySelector('#trend-summary').textContent = summary.join(' ');

  trendDialog.showModal();
  renderChart();
  renderTable();
}

new ResizeObserver(() => {
  if (current && trendDialog.open) renderChart();
}).observe(chartElement);

document.querySelector('#close-trend').addEventListener('click', () => trendDialog.close());
trendDialog.addEventListener('click', event => {
  if (event.target === trendDialog) trendDialog.close();
});
