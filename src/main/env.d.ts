declare module '*.png?asset' {
    const content: string
    export default content
}

// Deep import of @xterm/headless's CommonJS build (see TerminalMirror.ts).
declare module '@xterm/headless/lib-headless/xterm-headless.js' {
    export * from '@xterm/headless'
}

// Deep import of @xterm/addon-serialize's CommonJS build, for the same reason.
declare module '@xterm/addon-serialize/lib/addon-serialize.js' {
    export * from '@xterm/addon-serialize'
}
