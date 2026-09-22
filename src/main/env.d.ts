declare module '*.png?asset' {
    const content: string
    export default content
}

// Deep import of @xterm/headless's CommonJS build (see TerminalMirror.ts).
declare module '@xterm/headless/lib-headless/xterm-headless.js' {
    export * from '@xterm/headless'
}
