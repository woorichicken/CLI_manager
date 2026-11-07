/**
 * The script put in front of every document the phone opens (decision 0011). Reports were written for a browser tab:
 * they keep comments in localStorage and hand them over through the clipboard or a saved file. A sandboxed page has none
 * of those, and four kits do it three ways, so this stands in for the browser's own objects rather than asking each kit
 * to change — reports already on disk work too.
 *
 * It adds no power: the page's code could post these messages itself, and the phone page acts on none of them without the
 * person's press. ASCII only, whatever the page's encoding, and no closing script tag.
 */
export const PHONE_DOC_BRIDGE = String.raw`(function () {
    'use strict'
    window.__climDocBridge = true
    var post = function (message) { parent.postMessage(message, '*') }

    // Storage. The seed comes in the address's fragment, which never reaches the server, and leaves it at once.
    var seed = {}
    var seeded = false
    var place = location.hash
    try {
        var found = /^#seed=([^&]*)(?:&hash=(.*))?$/.exec(location.hash)
        if (found) {
            seed = JSON.parse(decodeURIComponent(found[1])) || {}
            seeded = true
            place = found[2] ? decodeURIComponent(found[2]) : ''
            history.replaceState(null, '', location.pathname + location.search + place)
        }
    } catch (e) {}
    // The phone page gives a page without them its kept comments in the address. Only the fragment differs, so nothing loads.
    window.addEventListener('hashchange', function () {
        if (/^#seed=/.test(location.hash)) location.reload()
    })
    var makeStore = function (data, changed) {
        var has = function (key) { return Object.prototype.hasOwnProperty.call(data, key) }
        return {
            getItem: function (key) { return has(key) ? data[key] : null },
            setItem: function (key, value) { data[key] = String(value); changed() },
            removeItem: function (key) { delete data[key]; changed() },
            clear: function () { Object.keys(data).forEach(function (key) { delete data[key] }); changed() },
            key: function (index) { return Object.keys(data)[index] || null },
            get length() { return Object.keys(data).length }
        }
    }
    var kept = makeStore(seed, function () { post({ type: 'doc-store', value: JSON.stringify(seed) }) })
    Object.defineProperty(window, 'localStorage', { value: kept, configurable: true })
    Object.defineProperty(window, 'sessionStorage', { value: makeStore({}, function () {}), configurable: true })
    Object.defineProperty(document, 'cookie', { get: function () { return '' }, set: function () {}, configurable: true })

    // Comments: however a kit hands them over, they become the text of the phone page's sheet.
    var give = function (text, via) {
        if (String(text).trim()) post({ type: 'doc-comment', text: String(text), via: via })
        // before-after then says "go to the terminal and paste": not here. Its other guides stay
        setTimeout(function () {
            var guide = document.getElementById('guide')
            if (guide) guide.classList.remove('on')
        }, 0)
    }
    Object.defineProperty(navigator, 'clipboard', {
        value: { writeText: function (text) { give(text, 'clipboard'); return Promise.resolve() } },
        configurable: true
    })
    var exec = document.execCommand.bind(document)
    document.execCommand = function (command) {
        if (String(command).toLowerCase() !== 'copy') return exec.apply(null, arguments)
        var field = document.activeElement
        give(field && typeof field.value === 'string' ? field.value.slice(field.selectionStart, field.selectionEnd) : String(getSelection()), 'execCommand')
        return true
    }
    var blobs = new Map()
    var makeUrl = URL.createObjectURL.bind(URL)
    URL.createObjectURL = function (blob) {
        var url = makeUrl(blob)
        blobs.set(url, blob)
        return url
    }
    var saved = function (anchor) {
        var blob = blobs.get(anchor.href)
        if (!blob) return false
        var reader = new FileReader()
        reader.onload = function () { give(reader.result, 'download') }
        reader.readAsText(blob)
        return true
    }
    var anchorClick = HTMLAnchorElement.prototype.click
    HTMLAnchorElement.prototype.click = function () {
        if (this.download && saved(this)) return
        return anchorClick.apply(this, arguments)
    }

    // Links. Moving inside the folder replaces the page: a history entry would be one more press of the panel's back.
    var base = location.pathname.split('/').slice(0, 3).join('/') + '/'
    document.addEventListener('click', function (event) {
        var anchor = event.target && event.target.closest && event.target.closest('a[href]')
        if (!anchor) return
        if (anchor.download && saved(anchor)) { event.preventDefault(); return }
        var raw = anchor.getAttribute('href') || ''
        if (raw.charAt(0) === '#') {
            event.preventDefault()
            location.replace(raw)
            return
        }
        var url
        try { url = new URL(anchor.href) } catch (e) { return }
        if (url.protocol === 'file:') {
            event.preventDefault()
            post({ type: 'doc-open', path: decodeURIComponent(url.pathname) })
        } else if (url.host === location.host && url.pathname.indexOf(base) === 0) {
            if (/\.html?$/i.test(url.pathname)) {
                event.preventDefault()
                location.replace(url.href)
            }
        } else if (url.host === location.host) {
            // an absolute path written for a browser opening files: a path of the Mac, judged like any other
            event.preventDefault()
            post({ type: 'doc-open', path: decodeURIComponent(url.pathname) })
        } else if (/^(https?|mailto):$/.test(url.protocol)) {
            event.preventDefault()
            post({ type: 'doc-link', url: url.href })
        } else {
            event.preventDefault()
        }
    }, true)

    // What did not load: outside this folder, or on the web. Said by the phone page, not left as a broken picture.
    var missing = 0
    var report = null
    window.addEventListener('error', function (event) {
        var tag = event.target && event.target.tagName
        if (tag !== 'IMG' && tag !== 'LINK' && tag !== 'SCRIPT' && tag !== 'SOURCE' && tag !== 'VIDEO' && tag !== 'AUDIO') return
        missing += 1
        if (report === null) {
            report = setTimeout(function () {
                report = null
                post({ type: 'doc-missing', count: missing })
            }, 200)
        }
    }, true)

    // The keyboard. The phone page shrinks with it (interactive-widget=resizes-content), so this frame gets a resize a
    // browser tab would not. before-after redraws on resize, which replaces the field being typed in: focus gone, keyboard
    // down, nothing can be written. Height alone, while typing, is the keyboard: the page does not need to know.
    // The short frame also keeps a page's fixed and sticky bars on screen, a tab's would sit behind the keyboard, so they
    // can cover the field. What covers it steps aside until the keyboard goes.
    var width = innerWidth
    var height = innerHeight
    var keyboard = false
    var stepped = []
    var typing = function () {
        var field = document.activeElement
        return !!field && (field.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(field.tagName))
    }
    var stepBack = function () {
        stepped.forEach(function (entry) { entry.element.style.visibility = entry.was })
        stepped = []
    }
    var uncover = function () {
        stepBack()
        var field = document.activeElement
        field.scrollIntoView({ block: 'center' })
        var box = field.getBoundingClientRect()
        Array.prototype.forEach.call(document.querySelectorAll('body *'), function (element) {
            if (element.contains(field) || field.contains(element)) return
            var position = getComputedStyle(element).position
            if (position !== 'fixed' && position !== 'sticky') return
            var other = element.getBoundingClientRect()
            if (other.bottom <= box.top || other.top >= box.bottom || other.right <= box.left || other.left >= box.right) return
            stepped.push({ element: element, was: element.style.visibility })
            element.style.visibility = 'hidden'
        })
    }
    window.addEventListener('resize', function (event) {
        var sameWidth = innerWidth === width
        var shorter = innerHeight < height
        width = innerWidth
        height = innerHeight
        if (!sameWidth || !typing()) {
            keyboard = false
            stepBack()
            return
        }
        event.stopImmediatePropagation()
        keyboard = shorter
        if (keyboard) uncover()
        else stepBack()
    }, true)
    document.addEventListener('focusin', function () {
        if (keyboard && typing()) uncover()
    })
    document.addEventListener('focusout', function () {
        // the next field's focusin comes straight after: only when nothing took over
        setTimeout(function () { if (!typing()) stepBack() }, 0)
    })

    // Each kit's own button says what it does here.
    var relabel = function () {
        ['eli5-fb-copy', 'btn-copy', 'hfk-copy', 'pf-copy'].forEach(function (id) {
            var button = document.getElementById(id)
            if (button) button.textContent = 'Send to session'
        })
    }
    document.addEventListener('DOMContentLoaded', relabel)
    window.addEventListener('load', relabel)

    var path = location.pathname.slice(base.length)
    try { path = decodeURIComponent(path) } catch (e) {}
    var ready = function () { post({ type: 'doc-ready', title: document.title, path: path, seeded: seeded, hash: place }) }
    ready()
    document.addEventListener('DOMContentLoaded', function () {
        ready()
        // the seed held the address's fragment, so the browser did not scroll to the page's own
        if (seeded && place.length > 1) location.replace(place)
    })
})()
`
