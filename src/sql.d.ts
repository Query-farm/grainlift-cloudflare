// SQL files are bundled as text (wrangler.jsonc "rules").
declare module "*.sql" {
  const text: string;
  export default text;
}
