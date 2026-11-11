/** Vite resolves `?url` imports to the address of the built asset. */
declare module "*?url" {
  const url: string;
  export default url;
}
