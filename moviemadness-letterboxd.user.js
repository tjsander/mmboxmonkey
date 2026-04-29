// ==UserScript==
// @name         Movie Madness Availability for Letterboxd
// @namespace    https://letterboxd.com
// @version      1.0.0
// @description  Shows Movie Madness Portland rental availability on Letterboxd film pages
// @author       Travis Sanders
// @match        https://letterboxd.com/film/*
// @homepageURL  https://github.com/tjsander/mmboxmonkey
// @downloadURL  https://github.com/tjsander/mmboxmonkey/raw/main/moviemadness-letterboxd.user.js
// @updateURL    https://github.com/tjsander/mmboxmonkey/raw/main/moviemadness-letterboxd.user.js
// @grant        GM_xmlhttpRequest
// @connect      moviemadness.org
// ==/UserScript==

(function () {
    'use strict';

    const MM_BASE = 'https://www.moviemadness.org';

    const FORMAT_ORDER = ['4K UHD', 'Blu-Ray', 'DVD', 'VHS'];

    // MM title strings use e.g. "(BLU RAY)" and "(BLU-RAY)" interchangeably.
    const FORMAT_PATTERNS = [
        { re: /\(4K\s*UHD(?:[\s-]?BLU[\s-]?RAY)?\)/i, label: '4K UHD' },
        { re: /\(BLU[\s-]?RAY\)/i,                     label: 'Blu-Ray' },
        { re: /\(DVD\)/i,                               label: 'DVD' },
        { re: /\(VHS\)/i,                               label: 'VHS' },
    ];

    const FORMAT_COLORS = {
        '4K UHD':  '#e8832a',
        'Blu-Ray': '#4c9be8',
        'DVD':     '#67c267',
        'VHS':     '#c8a84b',
    };

    function getFilmInfo() {
        let title = null;
        let year  = null;

        const ogTitle = document.querySelector('meta[property="og:title"]');
        if (ogTitle) {
            const content = ogTitle.getAttribute('content') || '';
            const m = content.match(/^(.*?)\s*\((\d{4})\)\s*$/);
            if (m) {
                title = m[1].trim();
                year  = m[2];
            } else {
                title = content.trim();
            }
        }

        if (!title) {
            title = document.querySelector('h1')?.textContent.trim() ?? null;
        }
        if (!year) {
            year = document.querySelector('a[href*="/films/year/"]')?.textContent.trim() ?? null;
        }

        return { title, year };
    }

    // Databases disagree on Roman vs Arabic sequel numbers (e.g. "III" vs "3").
    // Applied after lowercasing so we match on the lowercase forms.
    const ROMAN_NUMERALS = [
        [/\bxiii\b/g, '13'], [/\bxii\b/g, '12'], [/\bxi\b/g, '11'],
        [/\bix\b/g,   '9'],  [/\bviii\b/g, '8'], [/\bvii\b/g, '7'],
        [/\bvi\b/g,   '6'],  [/\biv\b/g,   '4'], [/\biii\b/g, '3'],
        [/\bii\b/g,   '2'],  [/\bx\b/g,   '10'], [/\bv\b/g,   '5'],
    ];

    // Handles MM "TITLE, THE" <-> Letterboxd "The Title" convention,
    // and Roman <-> Arabic numeral mismatches in sequel titles.
    function normalizeForMatch(str) {
        const s = str
            .toLowerCase()
            .replace(/,\s*(the|a|an)\s*$/i, '')
            .replace(/^(the|a|an)\s+/i, '')
            .replace(/[^a-z0-9\s]/g, '')
            .replace(/\s+/g, ' ')
            .trim();
        return ROMAN_NUMERALS.reduce((acc, [re, n]) => acc.replace(re, n), s);
    }

    // MM titles embed format and edition in parens: "HELLRAISER (BLU-RAY)",
    // "JENNIFER'S BODY (UNRATED)(DVD)", "GODFATHER, THE (1972) (DVD)".
    function mmTitleBase(mmTitle) {
        return mmTitle.replace(/\s*\([^)]*\)/g, '').trim();
    }

    function titlesMatch(searchTitle, mmTitle) {
        return normalizeForMatch(searchTitle) === normalizeForMatch(mmTitleBase(mmTitle));
    }

    // Prepare a title for use as a MovieMadness search query.
    // Converts Roman numerals (III → 3) and strips punctuation that breaks
    // MM search (colons cause zero results for e.g. "The Lost World: Jurassic Park").
    function toSearchQuery(title) {
        return ROMAN_NUMERALS
            .reduce((acc, [re, n]) => acc.replace(new RegExp(re.source, 'gi'), n), title)
            .replace(/[:'"""]/g, '')
            .trim();
    }

    // MM location strings concatenate section + subsection without a separator:
    // "Leviathans & BehemothsGODZILLA" → "Leviathans & Behemoths > GODZILLA"
    function formatLocation(loc) {
        return loc.replace(/([a-z])([A-Z])/g, '$1 > $2');
    }

    // Returns { formats: Set<string>, location: string|null }
    function parseSearchResults(html, title, year) {
        const parser = new DOMParser();
        const doc    = parser.parseFromString(html, 'text/html');
        const found  = new Set();
        let location = null;

        doc.querySelectorAll('h1, h2, h3, h4, h5').forEach(el => {
            const text = el.textContent.trim();
            if (!text) return;

            // Allow ±1 year tolerance — databases often disagree for films with
            // late or multi-country releases (e.g. Casablanca: 1942 vs 1943).
            if (year) {
                const elYear = text.match(/\((\d{4})\)/)?.[1];
                if (elYear && Math.abs(Number(elYear) - Number(year)) > 1) return;
            }

            if (!titlesMatch(title, text)) return;

            FORMAT_PATTERNS.forEach(({ re, label }) => {
                if (re.test(text)) found.add(label);
            });

            const card = el.parentElement?.closest('article, section, li') ?? el.parentElement;

            // Some entries have no format in the heading (e.g. "JEEPERS CREEPERS 2
            // (COLLECTORS EDITION)") — fall back to bare format badges in the card.
            if (card) {
                card.querySelectorAll('*').forEach(child => {
                    if (child.children.length > 0) return;
                    const t = child.textContent.trim();
                    if (/^DVD$/i.test(t))           found.add('DVD');
                    else if (/^VHS$/i.test(t))      found.add('VHS');
                    else if (/^BLU[\s-]?RAY$/i.test(t)) found.add('Blu-Ray');
                    else if (/^4K\s*UHD$/i.test(t)) found.add('4K UHD');
                });
            }

            if (location !== null) return;
            if (!card) return;

            for (const child of card.querySelectorAll('*')) {
                const t = child.textContent.trim();
                if (!t.startsWith('MM LOCATION')) continue;
                const inlineMatch = t.match(/MM LOCATION[:\s]+(.+)/);
                if (inlineMatch) {
                    location = formatLocation(inlineMatch[1].trim());
                } else if (child.nextElementSibling) {
                    location = formatLocation(child.nextElementSibling.textContent.trim());
                }
                break;
            }
        });

        return { formats: found, location };
    }

    function buildWidget(formats, location, searchUrl) {
        const style = document.createElement('style');
        style.textContent = '#mm-availability a.mm-badge:hover { opacity: 0.8; }';
        document.head.appendChild(style);

        const widget = document.createElement('section');
        widget.id = 'mm-availability';
        widget.style.cssText = [
            'margin:1.2em 0',
            'padding:0.7em 1em',
            'background:rgba(255,255,255,0.05)',
            'border-left:3px solid #e9b84a',
            'border-radius:3px',
            'font-size:0.85em',
            'line-height:1.4',
        ].join(';');

        const header = document.createElement('p');
        header.style.cssText = 'margin:0 0 0.5em;display:flex;align-items:center;gap:0.4em;';

        const favicon = document.createElement('img');
        favicon.src    = `${MM_BASE}/wp-content/uploads/2024/09/cropped-MM-favicon-32x32.png`;
        favicon.width  = 16;
        favicon.height = 16;
        favicon.style.cssText = 'display:block;flex-shrink:0;';

        const mmLabel = document.createElement('span');
        mmLabel.textContent = 'Movie Madness';
        mmLabel.style.cssText = 'color:#e9b84a;font-weight:600;';

        header.appendChild(favicon);
        header.appendChild(mmLabel);
        widget.appendChild(header);

        if (formats.size === 0) {
            const msg = document.createElement('p');
            msg.style.cssText = 'margin:0;';
            const link = document.createElement('a');
            link.href = searchUrl;
            link.target = '_blank';
            link.rel = 'noopener noreferrer';
            link.textContent = 'Not found in collection';
            link.style.cssText = 'color:#567;';
            msg.appendChild(link);
            widget.appendChild(msg);
        } else {
            const row = document.createElement('div');
            row.style.cssText = 'display:flex;gap:0.4em;flex-wrap:wrap;';

            FORMAT_ORDER.forEach(fmt => {
                if (!formats.has(fmt)) return;
                const badge = document.createElement('a');
                badge.className = 'mm-badge';
                badge.href      = searchUrl;
                badge.target    = '_blank';
                badge.rel       = 'noopener noreferrer';
                badge.textContent = fmt;
                badge.title     = `Rent ${fmt} at Movie Madness`;
                badge.style.cssText = [
                    `background:${FORMAT_COLORS[fmt]}`,
                    'color:#fff',
                    'padding:0.2em 0.55em',
                    'border-radius:3px',
                    'font-size:0.9em',
                    'font-weight:600',
                    'text-decoration:none',
                    'white-space:nowrap',
                ].join(';');
                row.appendChild(badge);
            });

            widget.appendChild(row);

            if (location) {
                const loc = document.createElement('p');
                loc.textContent = location;
                loc.style.cssText = 'margin:0.5em 0 0;font-size:0.85em;color:#678;';
                widget.appendChild(loc);
            }
        }

        return widget;
    }

    // Watches for `primary` to appear in the DOM; falls back to the first match
    // in `fallbacks` after `timeoutMs`. Only needed because the watch panel
    // renders dynamically and may be empty for films with no streaming options.
    function waitForElement(primary, fallbacks, timeoutMs, cb) {
        const existing = document.querySelector(primary);
        if (existing) { cb(existing); return; }

        let done = false;

        const observer = new MutationObserver(() => {
            if (done) return;
            const el = document.querySelector(primary);
            if (el) {
                done = true;
                observer.disconnect();
                clearTimeout(timer);
                cb(el);
            }
        });
        observer.observe(document.body, { childList: true, subtree: true });

        const timer = setTimeout(() => {
            if (done) return;
            done = true;
            observer.disconnect();
            for (const sel of fallbacks) {
                const el = document.querySelector(sel);
                if (el) { cb(el); return; }
            }
        }, timeoutMs);
    }

    function run() {
        const { title, year } = getFilmInfo();
        if (!title) return;

        const searchUrl = `${MM_BASE}/search/?query=${encodeURIComponent(toSearchQuery(title))}`;
        let fetchedWidget = null;
        let anchor        = null;

        function tryInject() {
            if (!fetchedWidget || !anchor) return;
            anchor.insertAdjacentElement('afterend', fetchedWidget);
        }

        GM_xmlhttpRequest({
            method: 'GET',
            url:    searchUrl,
            onload(response) {
                try {
                    const { formats, location } = parseSearchResults(response.responseText, title, year);
                    fetchedWidget = buildWidget(formats, location, searchUrl);
                } catch (e) {
                    fetchedWidget = null;
                }
                tryInject();
            },
            onerror() {},
        });

        // #watch > section exists when streaming options are listed; falls back
        // to #watch or section.watch-panel for films with no streaming options.
        waitForElement('#watch > section', ['#watch', 'section.watch-panel'], 5000, el => {
            anchor = el;
            tryInject();
        });
    }

    run();
})();
