export const css = await Deno.readTextFile(
  new URL("../../public/styles.css", import.meta.url),
);
