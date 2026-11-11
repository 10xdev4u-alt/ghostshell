/// <reference types="vite/client" />

declare module '*.wasm?inline' {
  const url: string;
  export default url;
}
