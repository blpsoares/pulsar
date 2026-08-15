/**
 * Sequências ANSI de controle de terminal.
 *
 * Ficam em `core` (e não em `tui/mouse/parse.ts`, onde as de mouse nasceram)
 * porque quem precisa soltar o terminal é a camada de serviço, e `core` não
 * pode importar de `tui`. O `parse.ts` passa a reexportar daqui para não haver
 * duas verdades sobre a mesma sequência.
 */

export const ENTER_ALT = "\x1b[?1049h";
export const LEAVE_ALT = "\x1b[?1049l";
export const ENABLE_MOUSE = "\x1b[?1000h\x1b[?1006h";
export const DISABLE_MOUSE = "\x1b[?1006l\x1b[?1000l";
