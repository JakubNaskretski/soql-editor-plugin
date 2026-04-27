(function() {
    document.getElementById('jsCheck').style.display = 'none';
    try {
    const vscode = acquireVsCodeApi();
    const input = document.getElementById('soqlInput');
    const dropdown = document.getElementById('acDropdown');
    const resultsArea = document.getElementById('resultsArea');
    const resultActions = document.getElementById('resultActions');
    const btnCopyResults = document.getElementById('btnCopyResults');
    const btnCopyCSV = document.getElementById('btnCopyCSV');
    const btnExportJSON = document.getElementById('btnExportJSON');
    const btnRun = document.getElementById('btnRun');
    const btnLoadMd = document.getElementById('btnLoadMd');
    const orgLabel = document.getElementById('orgLabel');
    const consoleHeader = document.getElementById('consoleHeader');
    const consoleChevron = document.getElementById('consoleChevron');
    const consoleBadge = document.getElementById('consoleBadge');
    const consoleClear = document.getElementById('consoleClear');
    const consoleBody = document.getElementById('consoleBody');
    const highlightOverlay = document.getElementById('highlightOverlay');
    const errorList = document.getElementById('errorList');
    const tabBar = document.getElementById('tabBar');
    const btnAddTab = document.getElementById('btnAddTab');

    const MAX_TABS = 3;
    const MAX_RENDER_ROWS = 10000;

    let suggestions = [];
    let selectedIdx = -1;
    let acVisible = false;
    let debounceTimer = null;
    let validationTimer = null;
    let currentErrors = [];
    let lastCursorPos = -1;
    let logCount = 0;
    let consoleOpen = false;
    let lastColumns = [];
    let lastRows = [];
    let lastRawRows = [];
    let currentOrgLabel = 'No Org';

    // ── multi-tab state ──
    let activeTab = 0;
    let tabs = [
        { query: '', columns: [], rows: [], rawRows: [], totalSize: 0, errors: [], hasResults: false }
    ];

    function createTabState() {
        return { query: '', columns: [], rows: [], rawRows: [], totalSize: 0, errors: [], hasResults: false };
    }

    // ── tab bar rendering ──
    function renderTabBar() {
        // Remove existing tab buttons (keep btnAddTab)
        const existing = tabBar.querySelectorAll('.tab');
        existing.forEach(el => el.remove());

        tabs.forEach((t, i) => {
            const btn = document.createElement('button');
            btn.className = 'tab' + (i === activeTab ? ' active' : '');
            btn.setAttribute('data-tab', String(i));
            btn.textContent = 'Query ' + (i + 1);
            if (tabs.length > 1) {
                const close = document.createElement('span');
                close.className = 'tab-close';
                close.textContent = '\u00D7';
                close.addEventListener('click', (e) => { e.stopPropagation(); closeTab(i); });
                btn.appendChild(close);
            }
            btn.addEventListener('click', () => switchTab(i));
            tabBar.insertBefore(btn, btnAddTab);
        });

        btnAddTab.style.display = tabs.length >= MAX_TABS ? 'none' : '';
    }

    function saveCurrentTab() {
        const tab = tabs[activeTab];
        if (!tab) return;
        tab.query = input.value;
        tab.errors = currentErrors;
        tab.columns = lastColumns;
        tab.rows = lastRows;
        tab.rawRows = lastRawRows;
        tab.hasResults = resultActions.classList.contains('visible');
    }

    function restoreTab(idx) {
        const tab = tabs[idx];
        input.value = tab.query || '';
        currentErrors = tab.errors || [];
        lastColumns = tab.columns || [];
        lastRows = tab.rows || [];
        lastRawRows = tab.rawRows || [];
        if (tab.hasResults && lastColumns.length > 0) {
            resultActions.classList.add('visible');
            renderResults(lastColumns, lastRows, tab.totalSize || lastRows.length);
        } else {
            resultActions.classList.remove('visible');
            resultsArea.innerHTML = '<div class="info-msg">Type a SOQL query above and click Run</div>';
        }
        renderErrorList();
        highlightSoql();
    }

    function switchTab(idx) {
        if (idx === activeTab) return;
        saveCurrentTab();
        activeTab = idx;
        restoreTab(idx);
        renderTabBar();
        persistState();
        input.focus();
    }

    function addTab() {
        if (tabs.length >= MAX_TABS) return;
        saveCurrentTab();
        tabs.push(createTabState());
        activeTab = tabs.length - 1;
        restoreTab(activeTab);
        renderTabBar();
        persistState();
        input.focus();
    }

    function closeTab(idx) {
        if (tabs.length <= 1) return;
        tabs.splice(idx, 1);
        if (activeTab >= tabs.length) {
            activeTab = tabs.length - 1;
        } else if (activeTab > idx) {
            activeTab--;
        }
        restoreTab(activeTab);
        renderTabBar();
        persistState();
        input.focus();
    }

    function persistState() {
        saveCurrentTab();
        vscode.setState({ tabs, activeTab, orgLabel: currentOrgLabel });
    }

    function bindResultListeners() {
        // Clickable Salesforce record IDs
        resultsArea.querySelectorAll('.sf-id-link').forEach(link => {
            link.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                vscode.postMessage({ type: 'openRecord', recordId: link.dataset.id });
            });
        });
        // Click cell to copy
        resultsArea.querySelectorAll('.results-table td').forEach(td => {
            td.style.cursor = 'pointer';
            td.addEventListener('click', () => {
                const val = td.textContent;
                if (val && val !== 'null') {
                    vscode.postMessage({ type: 'copyToClipboard', text: val });
                }
            });
        });
    }

    btnAddTab.addEventListener('click', () => addTab());

    // ── console ──
    consoleHeader.addEventListener('click', (e) => {
        if (e.target === consoleClear) return;
        consoleOpen = !consoleOpen;
        consoleBody.classList.toggle('open', consoleOpen);
        consoleChevron.classList.toggle('open', consoleOpen);
        if (consoleOpen) {
            logCount = 0;
            consoleBadge.textContent = '0';
            consoleBody.scrollTop = consoleBody.scrollHeight;
        }
    });
    consoleClear.addEventListener('click', (e) => {
        e.stopPropagation();
        consoleBody.innerHTML = '';
        logCount = 0;
        consoleBadge.textContent = '0';
    });

    function appendLog(level, message) {
        const line = document.createElement('div');
        line.className = 'log-line ' + level;
        line.textContent = message;
        consoleBody.appendChild(line);
        // Keep max 200 lines
        while (consoleBody.children.length > 200) {
            consoleBody.removeChild(consoleBody.firstChild);
        }
        if (consoleOpen) {
            consoleBody.scrollTop = consoleBody.scrollHeight;
        } else {
            logCount++;
            consoleBadge.textContent = String(logCount);
        }
    }

    // ── run query ──
    btnRun.addEventListener('click', () => runQuery());
    btnLoadMd.addEventListener('click', () => vscode.postMessage({ type: 'loadMetadata' }));
    orgLabel.addEventListener('click', () => vscode.postMessage({ type: 'selectOrg' }));
    btnCopyResults.addEventListener('click', () => {
        if (!lastColumns.length) return;
        const header = lastColumns.join('\t');
        const body = lastRows.map(r => lastColumns.map(c => r[c] || '').join('\t')).join('\n');
        vscode.postMessage({ type: 'copyToClipboard', text: header + '\n' + body });
    });
    btnCopyCSV.addEventListener('click', () => {
        if (!lastColumns.length) return;
        const csvEsc = (v) => { const s = String(v || ''); return s.includes(',') || s.includes('"') || s.includes('\n') ? '"' + s.replace(/"/g, '""') + '"' : s; };
        const header = lastColumns.map(csvEsc).join(',');
        const body = lastRows.map(r => lastColumns.map(c => csvEsc(r[c])).join(',')).join('\n');
        vscode.postMessage({ type: 'openCSV', text: header + '\n' + body });
    });
    btnExportJSON.addEventListener('click', () => {
        if (!lastRawRows.length) return;
        const json = JSON.stringify(lastRawRows, null, 2);
        vscode.postMessage({ type: 'openJSON', text: json });
    });

    let navigating = false; // true while user is arrow-navigating the dropdown

    input.addEventListener('keydown', (e) => {
        if (acVisible) {
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                navigating = true;
                selectedIdx = Math.min(selectedIdx + 1, suggestions.length - 1);
                renderDropdown();
                return;
            }
            if (e.key === 'ArrowUp') {
                e.preventDefault();
                navigating = true;
                selectedIdx = Math.max(selectedIdx - 1, 0);
                renderDropdown();
                return;
            }
            if (e.key === 'Tab' || e.key === 'Enter') {
                if (selectedIdx >= 0 && selectedIdx < suggestions.length) {
                    e.preventDefault();
                    acceptSuggestion(suggestions[selectedIdx]);
                    return;
                }
            }
            if (e.key === 'Escape') {
                e.preventDefault();
                hideDropdown();
                return;
            }
        }
        // Cmd/Ctrl+Enter runs query
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            runQuery();
        }
    });

    input.addEventListener('input', () => {
        navigating = false; // user typed — reset navigation state
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => requestSuggestions(), 400);
        clearTimeout(validationTimer);
        validationTimer = setTimeout(() => requestValidation(), 500);
    });

    // Hide dropdown on outside click
    document.addEventListener('click', (e) => {
        if (!dropdown.contains(e.target) && e.target !== input) {
            hideDropdown();
        }
    });

    // Reset suggestions when cursor position changes (click or arrow keys)
    input.addEventListener('mouseup', () => {
        const pos = input.selectionStart;
        if (pos !== lastCursorPos) {
            lastCursorPos = pos;
            hideDropdown();
        }
    });
    input.addEventListener('keyup', (e) => {
        // Only track cursor movement keys (not handled by autocomplete)
        if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) {
            const pos = input.selectionStart;
            if (pos !== lastCursorPos) {
                lastCursorPos = pos;
                hideDropdown();
            }
        }
    });

    function runQuery() {
        hideDropdown();
        vscode.postMessage({ type: 'executeQuery', query: input.value });
    }

    function requestSuggestions() {
        const offset = input.selectionStart || 0;
        lastCursorPos = offset;
        vscode.postMessage({ type: 'requestSuggestions', text: input.value, offset });
    }

    function requestValidation() {
        vscode.postMessage({ type: 'requestValidation', text: input.value });
    }

    function acceptSuggestion(item) {
        const text = input.value;
        const offset = input.selectionStart || 0;

        // Find the partial word before cursor
        const before = text.substring(0, offset);
        const partialMatch = before.match(/[a-zA-Z_][a-zA-Z0-9_.]*$/);
        const partialLen = partialMatch ? partialMatch[0].length : 0;

        const newText = text.substring(0, offset - partialLen) + item.insertText + text.substring(offset);
        input.value = newText;
        const newPos = offset - partialLen + item.insertText.length;
        input.setSelectionRange(newPos, newPos);
        input.focus();
        hideDropdown();
    }

    function getCursorXY(textarea, position) {
        const mirror = document.createElement('div');
        const style = getComputedStyle(textarea);
        // Copy all relevant styles
        const props = [
            'fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing',
            'wordSpacing', 'textIndent', 'whiteSpace', 'wordWrap', 'overflowWrap',
            'tabSize', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
            'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
            'boxSizing'
        ];
        for (const prop of props) {
            mirror.style[prop] = style[prop];
        }
        mirror.style.position = 'absolute';
        mirror.style.visibility = 'hidden';
        mirror.style.overflow = 'hidden';
        mirror.style.width = textarea.offsetWidth + 'px';
        mirror.style.height = 'auto';

        const text = textarea.value.substring(0, position);
        mirror.textContent = text;

        // Add a span at the cursor position to measure
        const marker = document.createElement('span');
        marker.textContent = '|';
        mirror.appendChild(marker);

        document.body.appendChild(mirror);

        const markerRect = marker.offsetTop;
        const markerLeft = marker.offsetLeft;
        const scrollTop = textarea.scrollTop;

        document.body.removeChild(mirror);

        return {
            top: markerRect - scrollTop + parseInt(style.lineHeight || style.fontSize, 10) + parseInt(style.paddingTop, 10),
            left: 0
        };
    }

    function renderDropdown() {
        if (suggestions.length === 0) { hideDropdown(); return; }

        dropdown.innerHTML = suggestions.map((s, i) => {
            const cls = i === selectedIdx ? 'ac-item selected' : 'ac-item';
            const detail = s.detail ? '<span class="ac-detail">' + esc(s.detail) + '</span>' : '';
            return '<div class="' + cls + '" data-idx="' + i + '">' + esc(s.label) + detail + '</div>';
        }).join('');

        dropdown.querySelectorAll('.ac-item').forEach(el => {
            el.addEventListener('mousedown', (e) => {
                e.preventDefault();
                const idx = parseInt(el.getAttribute('data-idx'));
                acceptSuggestion(suggestions[idx]);
            });
        });

        // Position dropdown below the cursor (fixed positioning)
        const pos = getCursorXY(input, input.selectionStart || 0);
        const inputRect = input.getBoundingClientRect();
        dropdown.style.top = (inputRect.top + pos.top) + 'px';
        dropdown.style.left = inputRect.left + 'px';
        dropdown.classList.add('visible');
        acVisible = true;

        // Scroll selected into view
        const sel = dropdown.querySelector('.selected');
        if (sel) sel.scrollIntoView({ block: 'nearest' });
    }

    function hideDropdown() {
        dropdown.classList.remove('visible');
        acVisible = false;
        selectedIdx = -1;
        suggestions = [];
        navigating = false;
    }

    function esc(s) {
        const d = document.createElement('div');
        d.textContent = s;
        return d.innerHTML;
    }

    function showToast(message) {
        const existing = document.querySelector('.toast-msg');
        if (existing) existing.remove();
        const el = document.createElement('div');
        el.className = 'toast-msg';
        el.textContent = message;
        document.body.appendChild(el);
        setTimeout(() => el.remove(), 2000);
    }

    // ── messages from extension ──
    window.addEventListener('message', (event) => {
        const msg = event.data;
        switch (msg.type) {
            case 'suggestions':
                if (navigating) break; // don't reset selection while user is arrow-navigating
                suggestions = msg.items || [];
                selectedIdx = suggestions.length > 0 ? 0 : -1;
                renderDropdown();
                break;

            case 'queryStarted':
                resultsArea.innerHTML = '<div class="spinner">Running query...</div>';
                tabs[activeTab].hasResults = false;
                break;

            case 'queryResults':
                lastColumns = msg.columns;
                lastRows = msg.rows;
                lastRawRows = msg.rawRows || msg.rows || [];
                resultActions.classList.add('visible');
                renderResults(msg.columns, msg.rows, msg.totalSize);
                tabs[activeTab].columns = lastColumns;
                tabs[activeTab].rows = lastRows;
                tabs[activeTab].rawRows = lastRawRows;
                tabs[activeTab].totalSize = msg.totalSize;
                tabs[activeTab].hasResults = true;
                persistState();
                break;

            case 'error':
                resultsArea.innerHTML = '<div class="error-msg">&#10060; ' + esc(msg.message) + '</div>';
                tabs[activeTab].hasResults = false;
                persistState();
                break;

            case 'info':
                resultsArea.innerHTML = '<div class="info-msg">' + esc(msg.message) + '</div>';
                break;

            case 'orgChanged':
                currentOrgLabel = msg.alias || msg.username || 'No Org';
                orgLabel.textContent = currentOrgLabel;
                persistState();
                appendLog('info', 'Switched to org: ' + (msg.alias || msg.username));
                break;

            case 'log':
                appendLog(msg.level || 'info', msg.message);
                break;

            case 'toast':
                showToast(msg.message);
                break;

            case 'validationErrors':
                currentErrors = msg.errors || [];
                tabs[activeTab].errors = currentErrors;
                renderErrorList();
                highlightSoql();
                persistState();
                break;
        }
    });

    function renderResults(columns, rows, totalSize) {
        if (!rows || rows.length === 0) {
            resultsArea.innerHTML = '<div class="info-msg">Query returned 0 records</div>';
            return;
        }
        const truncated = rows.length > MAX_RENDER_ROWS;
        const displayedRows = truncated ? rows.slice(0, MAX_RENDER_ROWS) : rows;
        const headerCells = columns.map(c => '<th>' + esc(c) + '</th>').join('');
        const sfIdRegex = /^[a-zA-Z0-9]{15}([a-zA-Z0-9]{3})?$/;
        const bodyRows = displayedRows.map(row => {
            const cells = columns.map(c => {
                const val = row[c];
                if (val === 'null') return '<td class="null-val">null</td>';
                if (sfIdRegex.test(val)) {
                    return '<td title="' + esc(val) + '"><a class="sf-id-link" href="#" data-id="' + esc(val) + '">' + esc(val) + '</a></td>';
                }
                return '<td title="' + esc(val) + '">' + esc(val) + '</td>';
            }).join('');
            return '<tr>' + cells + '</tr>';
        }).join('');

        resultsArea.innerHTML =
            '<div class="results-summary">' +
            totalSize + ' record' + (totalSize !== 1 ? 's' : '') +
            (truncated ? ' (showing first ' + MAX_RENDER_ROWS + ')' : '') +
            '</div>' +
            '<table class="results-table"><thead><tr>' + headerCells + '</tr></thead>' +
            '<tbody>' + bodyRows + '</tbody></table>';

        bindResultListeners();
    }

    // ── error list rendering ──
    function renderErrorList() {
        if (currentErrors.length === 0) {
            errorList.classList.remove('visible');
            errorList.innerHTML = '';
            return;
        }
        errorList.innerHTML = currentErrors.map(e =>
            '<div class="error-item">' + esc(e.message) + '</div>'
        ).join('');
        errorList.classList.add('visible');
    }

    function lineColToOffset(text, line, col) {
        const lines = text.split('\n');
        let offset = 0;
        for (let i = 0; i < line && i < lines.length; i++) {
            offset += lines[i].length + 1;
        }
        return offset + col;
    }

    // ── syntax highlighting ──
    const SOQL_KEYWORDS = new Set([
        'SELECT', 'FROM', 'WHERE', 'AND', 'OR', 'NOT', 'IN', 'LIKE',
        'ORDER', 'BY', 'GROUP', 'HAVING', 'LIMIT', 'OFFSET', 'ASC', 'DESC',
        'NULLS', 'FIRST', 'LAST', 'WITH', 'AS', 'TYPEOF', 'WHEN', 'THEN', 'ELSE', 'END',
        'USING', 'SCOPE', 'DATA', 'CATEGORY', 'AT', 'ABOVE', 'BELOW', 'ABOVE_OR_BELOW',
        'FOR', 'VIEW', 'REFERENCE', 'UPDATE', 'TRACKING', 'VIEWSTAT',
        'INCLUDES', 'EXCLUDES', 'ALL', 'ROWS',
    ]);
    const SOQL_FUNCTIONS = new Set([
        'COUNT', 'COUNT_DISTINCT', 'SUM', 'AVG', 'MIN', 'MAX',
        'CALENDAR_MONTH', 'CALENDAR_QUARTER', 'CALENDAR_YEAR',
        'DAY_IN_MONTH', 'DAY_IN_WEEK', 'DAY_IN_YEAR', 'DAY_ONLY',
        'FISCAL_MONTH', 'FISCAL_QUARTER', 'FISCAL_YEAR',
        'HOUR_IN_DAY', 'WEEK_IN_MONTH', 'WEEK_IN_YEAR',
        'FORMAT', 'CONVERTCURRENCY', 'TOLABEL', 'CONVERT_TIMEZONE',
        'GROUPING', 'FIELDS',
    ]);
    const SOQL_OPERATORS = new Set(['=', '!=', '<', '>', '<=', '>=']);
    const SOQL_LITERALS = new Set(['TRUE', 'FALSE', 'NULL']);
    const DATE_LITERAL_RE = /^(TODAY|YESTERDAY|TOMORROW|LAST_WEEK|THIS_WEEK|NEXT_WEEK|LAST_MONTH|THIS_MONTH|NEXT_MONTH|LAST_QUARTER|THIS_QUARTER|NEXT_QUARTER|LAST_YEAR|THIS_YEAR|NEXT_YEAR|LAST_FISCAL_QUARTER|THIS_FISCAL_QUARTER|NEXT_FISCAL_QUARTER|LAST_FISCAL_YEAR|THIS_FISCAL_YEAR|NEXT_FISCAL_YEAR|LAST_90_DAYS|NEXT_90_DAYS|LAST_N_DAYS|NEXT_N_DAYS|LAST_N_WEEKS|NEXT_N_WEEKS|LAST_N_MONTHS|NEXT_N_MONTHS|LAST_N_QUARTERS|NEXT_N_QUARTERS|LAST_N_YEARS|NEXT_N_YEARS|LAST_N_FISCAL_QUARTERS|NEXT_N_FISCAL_QUARTERS|LAST_N_FISCAL_YEARS|NEXT_N_FISCAL_YEARS)$/i;

    function tokenizeSoql(text) {
        const tokens = [];
        let i = 0;
        while (i < text.length) {
            // Whitespace
            if (/\s/.test(text[i])) {
                let start = i;
                while (i < text.length && /\s/.test(text[i])) i++;
                tokens.push({ type: 'ws', value: text.substring(start, i) });
                continue;
            }
            // Single-line comment
            if (text[i] === '/' && text[i + 1] === '/') {
                let start = i;
                while (i < text.length && text[i] !== '\n') i++;
                tokens.push({ type: 'comment', value: text.substring(start, i) });
                continue;
            }
            // String literal
            if (text[i] === "'") {
                let start = i; i++;
                while (i < text.length && text[i] !== "'") i++;
                if (i < text.length) i++; // closing quote
                tokens.push({ type: 'string', value: text.substring(start, i) });
                continue;
            }
            // Number
            if (/\d/.test(text[i]) || (text[i] === '-' && i + 1 < text.length && /\d/.test(text[i + 1]))) {
                let start = i;
                if (text[i] === '-') i++;
                while (i < text.length && /[\d.]/.test(text[i])) i++;
                tokens.push({ type: 'number', value: text.substring(start, i) });
                continue;
            }
            // Operators
            if (i + 1 < text.length && SOQL_OPERATORS.has(text[i] + text[i + 1])) {
                tokens.push({ type: 'operator', value: text[i] + text[i + 1] });
                i += 2; continue;
            }
            if (SOQL_OPERATORS.has(text[i])) {
                tokens.push({ type: 'operator', value: text[i] });
                i++; continue;
            }
            // Parentheses, commas, dots
            if ('(),.:'.includes(text[i])) {
                tokens.push({ type: 'punctuation', value: text[i] });
                i++; continue;
            }
            // Words (identifiers, keywords, functions)
            if (/[a-zA-Z_]/.test(text[i])) {
                let start = i;
                while (i < text.length && /[a-zA-Z0-9_]/.test(text[i])) i++;
                // Include colon for date literals like LAST_N_DAYS:30
                let word = text.substring(start, i);
                if (text[i] === ':' && DATE_LITERAL_RE.test(word)) {
                    i++; // consume colon
                    while (i < text.length && /\d/.test(text[i])) i++; // consume number
                    word = text.substring(start, i);
                }
                const upper = word.toUpperCase();
                if (SOQL_KEYWORDS.has(upper) || SOQL_LITERALS.has(upper)) {
                    tokens.push({ type: 'keyword', value: word });
                } else if (SOQL_FUNCTIONS.has(upper.replace(/\(.*/, ''))) {
                    tokens.push({ type: 'function', value: word });
                } else if (DATE_LITERAL_RE.test(upper.replace(/:\d+$/, ''))) {
                    tokens.push({ type: 'date-literal', value: word });
                } else {
                    tokens.push({ type: 'field', value: word });
                }
                continue;
            }
            // Anything else
            tokens.push({ type: 'other', value: text[i] });
            i++;
        }
        return tokens;
    }

    function highlightSoql() {
        const text = input.value;
        if (!text) {
            highlightOverlay.innerHTML = '';
            return;
        }
        const tokens = tokenizeSoql(text);

        // Convert errors to character offset ranges
        const errorRanges = currentErrors.map(err => ({
            start: lineColToOffset(text, err.line, err.startCol),
            end: lineColToOffset(text, err.line, err.endCol),
            message: err.message
        }));

        let html = '';
        let charPos = 0;
        for (const tok of tokens) {
            const tokStart = charPos;
            const tokEnd = charPos + tok.value.length;

            // Check if this token overlaps with any error range
            const overlapping = errorRanges.filter(e => e.start < tokEnd && e.end > tokStart);

            if (overlapping.length === 0) {
                // No error — render normally
                if (tok.type === 'ws' || tok.type === 'punctuation' || tok.type === 'other') {
                    html += esc(tok.value);
                } else {
                    html += '<span class="tok-' + tok.type + '">' + esc(tok.value) + '</span>';
                }
            } else {
                // Token overlaps an error — add error class
                const tokenClass = (tok.type === 'ws' || tok.type === 'punctuation' || tok.type === 'other')
                    ? 'tok-error'
                    : 'tok-' + tok.type + ' tok-error';
                html += '<span class="' + tokenClass + '">' + esc(tok.value) + '</span>';
            }

            charPos = tokEnd;
        }
        // Add trailing newline so overlay height matches textarea
        html += '\n';
        highlightOverlay.innerHTML = html;
    }

    // Sync scroll between textarea and overlay
    input.addEventListener('scroll', () => {
        highlightOverlay.scrollTop = input.scrollTop;
        highlightOverlay.scrollLeft = input.scrollLeft;
    });

    // Restore state
    const state = vscode.getState();
    if (state && state.tabs) {
        tabs = state.tabs;
        activeTab = state.activeTab || 0;
        if (activeTab >= tabs.length) activeTab = 0;
        if (state.orgLabel) {
            currentOrgLabel = state.orgLabel;
            orgLabel.textContent = currentOrgLabel;
        }
        restoreTab(activeTab);
        renderTabBar();
    } else if (state && state.query) {
        // Migrate old single-query state
        tabs[0].query = state.query;
        input.value = state.query;
        renderTabBar();
    } else {
        renderTabBar();
    }
    // Save state on change + update highlighting
    function onInputChange() {
        persistState();
        highlightSoql();
    }
    input.addEventListener('input', onInputChange);
    input.addEventListener('change', onInputChange);
    input.addEventListener('keyup', highlightSoql);
    input.addEventListener('paste', () => setTimeout(highlightSoql, 0));
    input.addEventListener('focus', highlightSoql);

    // Initial highlight on load
    highlightSoql();
    // Initial validation on load
    if (input.value.trim().length > 0) {
        requestValidation();
    }
    } catch(initErr) {
        const banner = document.createElement('div');
        banner.style.padding = '8px';
        banner.style.color = 'red';
        banner.style.fontSize = '12px';
        banner.style.borderBottom = '2px solid red';
        const message = initErr && initErr.message ? initErr.message : String(initErr);
        banner.textContent = 'JS Init Error: ' + message;
        document.body.insertBefore(banner, document.body.firstChild);
    }
})();
