/*
 * T102's WebKit half, in its own process: another Playwright's page does not answer from inside this runner.
 * node t102-webkit.cjs <playwright-core> <phone page url> <owner login>
 * Prints one JSON line: what the frame's code got, and every request that left the browser.
 */
const [core, url, owner] = process.argv.slice(2)
const { webkit } = require(core)

;(async () => {
    const browser = await webkit.launch()
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, extraHTTPHeaders: { 'Tailscale-User-Login': owner, 'X-Forwarded-For': '100.101.102.103' } })
    const phone = await context.newPage()
    phone.setDefaultTimeout(20_000)
    const seen = []
    const errors = []
    phone.on('pageerror', (error) => errors.push(error.message))
    phone.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()) })
    phone.on('request', (request) => seen.push(`${request.method()} ${request.url()}`))
    const link = (words) => phone.getByTestId('chat-file-link').filter({ hasText: words }).first()
    await phone.goto(url)
    await link('the probe page').waitFor().catch(async (error) => {
        const words = (await phone.evaluate(() => document.body.innerText)).slice(0, 400)
        const me = await phone.evaluate(() => fetch('/api/phone/me').then((r) => r.text()))
        throw new Error(`${error.message}\npage: ${words}\nme: ${me}\nerrors: ${errors.join(' | ')}`)
    })
    await phone.evaluate(() => {
        window.addEventListener('message', (event) => {
            if (event.data && event.data.type === 'probe') window.__probe = event.data.R
        })
    })
    await link('the probe page').click()
    await phone.getByTestId('phone-doc-frame').waitFor()
    await phone.waitForFunction(() => window.__probe)
    const probe = await phone.evaluate(() => window.__probe)
    await phone.waitForTimeout(500)
    await phone.getByTestId('phone-doc-close').click()

    await link('the eli5 report').click()
    const frame = phone.frameLocator('[data-testid="phone-doc-frame"]')
    await frame.locator('.eli5-fb-btn').first().click()
    await frame.locator('#eli5-fb-ta-0').fill('webkit-comment-words')
    await frame.locator('#eli5-fb-copy').click()
    await phone.getByTestId('phone-doc-sheet').waitFor()
    const armedAtOnce = await phone.getByTestId('phone-doc-send').isEnabled()
    await phone.waitForTimeout(800)
    await phone.getByTestId('phone-doc-send').click()
    await phone.getByTestId('phone-doc-notice').waitFor()
    const version = browser.version()
    await browser.close()
    console.log(JSON.stringify({ version, probe, seen, armedAtOnce }))
})().catch((error) => {
    console.error(error)
    process.exit(1)
})
