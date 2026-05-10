import * as clack from "@clack/prompts";
import { FileSystem } from "@effect/platform";
import { dirname } from "node:path";
import { Context, Effect, Layer, Ref } from "effect";
import { styleText } from "node:util";

export type Severity = "info" | "success" | "warn" | "error";

export type DisplayEntry =
  | { readonly _tag: "intro"; readonly title: string }
  | {
      readonly _tag: "status";
      readonly message: string;
      readonly severity: Severity;
    }
  | { readonly _tag: "spinner"; readonly message: string }
  | {
      readonly _tag: "summary";
      readonly title: string;
      readonly rows: Record<string, string>;
    }
  | {
      readonly _tag: "taskLog";
      readonly title: string;
      readonly messages: ReadonlyArray<string>;
    }
  | { readonly _tag: "text"; readonly message: string }
  | {
      readonly _tag: "toolCall";
      readonly name: string;
      readonly formattedArgs: string;
    };

export interface DisplayService {
  readonly intro: (title: string) => Effect.Effect<void>;

  readonly status: (message: string, severity: Severity) => Effect.Effect<void>;

  readonly spinner: <A, E, R>(
    message: string,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;

  readonly summary: (
    title: string,
    rows: Record<string, string>,
  ) => Effect.Effect<void>;

  readonly taskLog: <A, E, R>(
    title: string,
    effect: (message: (msg: string) => void) => Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;

  readonly text: (message: string) => Effect.Effect<void>;

  readonly toolCall: (
    name: string,
    formattedArgs: string,
  ) => Effect.Effect<void>;
}

export interface PrefixedTerminalDisplayOptions {
  readonly name?: string;
}

export class Display extends Context.Tag("Display")<
  Display,
  DisplayService
>() {}

const makePrefixedMessage = (
  name: string | undefined,
  message: string,
): string => {
  const label = `[${name ?? "Agent"}]`;
  return message.startsWith(`${label} `) ? message : `${label} ${message}`;
};

const makePrefixedTerminalDisplayService = (
  options: PrefixedTerminalDisplayOptions,
): DisplayService => {
  const write = (message: string): Effect.Effect<void> =>
    Effect.sync(() => console.log(makePrefixedMessage(options.name, message)));

  return {
    intro: () => Effect.void,

    status: (message) => write(message),

    spinner: (message, effect) =>
      Effect.gen(function* () {
        yield* write(`${message}...`);
        const result = yield* effect;
        yield* write(`${message} done`);
        return result;
      }),

    summary: (title, rows) =>
      Effect.sync(() => {
        const lines = [
          makePrefixedMessage(options.name, title),
          ...Object.entries(rows).map(([key, value]) =>
            makePrefixedMessage(options.name, `  ${key}: ${value}`),
          ),
        ];
        console.log(lines.join("\n"));
      }),

    taskLog: (title, effect) =>
      Effect.gen(function* () {
        yield* write(title);
        const result = yield* effect((msg) => {
          console.log(makePrefixedMessage(options.name, `  ${msg}`));
        });
        yield* write(`${title} done`);
        return result;
      }),

    text: () => Effect.void,

    toolCall: () => Effect.void,
  };
};

const fanOutDisplayServices = (
  primary: DisplayService,
  secondary: DisplayService,
): DisplayService => ({
  intro: (title) =>
    Effect.gen(function* () {
      yield* primary.intro(title);
      yield* secondary.intro(title);
    }),

  status: (message, severity) =>
    Effect.gen(function* () {
      yield* primary.status(message, severity);
      yield* secondary.status(message, severity);
    }),

  spinner: (message, effect) =>
    primary.spinner(message, secondary.spinner(message, effect)),

  summary: (title, rows) =>
    Effect.gen(function* () {
      yield* primary.summary(title, rows);
      yield* secondary.summary(title, rows);
    }),

  taskLog: (title, effect) =>
    primary.taskLog(title, (primaryMessage) =>
      secondary.taskLog(title, (secondaryMessage) =>
        effect((msg) => {
          primaryMessage(msg);
          secondaryMessage(msg);
        }),
      ),
    ),

  text: (message) =>
    Effect.gen(function* () {
      yield* primary.text(message);
      yield* secondary.text(message);
    }),

  toolCall: (name, formattedArgs) =>
    Effect.gen(function* () {
      yield* primary.toolCall(name, formattedArgs);
      yield* secondary.toolCall(name, formattedArgs);
    }),
});

const makeFileDisplayService = (
  fs: FileSystem.FileSystem,
  filePath: string,
): Effect.Effect<DisplayService> =>
  Effect.gen(function* () {
    yield* fs
      .makeDirectory(dirname(filePath), { recursive: true })
      .pipe(Effect.orDie);
    const delimiter = `\n--- Run started: ${new Date().toISOString()} ---\n`;
    yield* fs
      .writeFileString(filePath, delimiter, { flag: "a" })
      .pipe(Effect.orDie);

    const appendToLog = (line: string): Effect.Effect<void> =>
      fs
        .writeFileString(filePath, line + "\n", { flag: "a" })
        .pipe(Effect.ignore);

    return {
      intro: () => Effect.void,

      status: (message, _severity) =>
        appendToLog(message.replace(/^\[[^\]]+\] /, "")),

      spinner: (message, effect) =>
        Effect.gen(function* () {
          yield* appendToLog(`${message}...`);
          const start = Date.now();
          const result = yield* effect;
          const elapsed = ((Date.now() - start) / 1000).toFixed(1);
          yield* appendToLog(`${message} done (${elapsed}s)`);
          return result;
        }),

      summary: (title, rows) => {
        const lines = Object.entries(rows)
          .map(([key, value]) => `  ${key}: ${value}`)
          .join("\n");
        return appendToLog(`${title}\n${lines}`);
      },

      taskLog: (title, effect) =>
        Effect.gen(function* () {
          yield* appendToLog(title);
          const start = Date.now();
          const messages: string[] = [];
          const result = yield* effect((msg) => {
            messages.push(msg);
          });
          const elapsed = ((Date.now() - start) / 1000).toFixed(1);
          for (const msg of messages) {
            yield* appendToLog(`  ${msg}`);
          }
          yield* appendToLog(`${title} done (${elapsed}s)`);
          return result;
        }),

      text: (message) => appendToLog(message),

      toolCall: (name, formattedArgs) =>
        appendToLog(`${name}(${formattedArgs})`),
    };
  });

export const SilentDisplay = {
  layer: (ref: Ref.Ref<ReadonlyArray<DisplayEntry>>): Layer.Layer<Display> =>
    Layer.succeed(Display, {
      intro: (title) =>
        Ref.update(ref, (entries) => [
          ...entries,
          { _tag: "intro" as const, title },
        ]),

      status: (message, severity) =>
        Ref.update(ref, (entries) => [
          ...entries,
          { _tag: "status" as const, message, severity },
        ]),

      spinner: (message, effect) =>
        Effect.flatMap(
          Ref.update(ref, (entries) => [
            ...entries,
            { _tag: "spinner" as const, message },
          ]),
          () => effect,
        ),

      summary: (title, rows) =>
        Ref.update(ref, (entries) => [
          ...entries,
          { _tag: "summary" as const, title, rows },
        ]),

      taskLog: (title, effect) => {
        const messages: string[] = [];
        return Effect.flatMap(
          effect((msg) => messages.push(msg)),
          (result) =>
            Effect.map(
              Ref.update(ref, (entries) => [
                ...entries,
                {
                  _tag: "taskLog" as const,
                  title,
                  messages: [...messages],
                },
              ]),
              () => result,
            ),
        );
      },

      text: (message) =>
        Ref.update(ref, (entries) => [
          ...entries,
          { _tag: "text" as const, message },
        ]),

      toolCall: (name, formattedArgs) =>
        Ref.update(ref, (entries) => [
          ...entries,
          { _tag: "toolCall" as const, name, formattedArgs },
        ]),
    }),
};

export const FileDisplay = {
  layer: (
    filePath: string,
  ): Layer.Layer<Display, never, FileSystem.FileSystem> =>
    Layer.effect(
      Display,
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        return yield* makeFileDisplayService(fs, filePath);
      }),
    ),
};

export const FileAndTerminalDisplay = {
  layer: (
    filePath: string,
    options: PrefixedTerminalDisplayOptions,
  ): Layer.Layer<Display, never, FileSystem.FileSystem> =>
    Layer.effect(
      Display,
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const fileDisplay = yield* makeFileDisplayService(fs, filePath);

        return fanOutDisplayServices(
          fileDisplay,
          makePrefixedTerminalDisplayService(options),
        );
      }),
    ),
};

const severityToClack: Record<Severity, (message: string) => void> = {
  info: clack.log.info,
  success: clack.log.success,
  warn: clack.log.warning,
  error: clack.log.error,
};

export const terminalStyle = {
  status: (message: string): string => styleText("bold", message),
  summaryTitle: (title: string): string => styleText("bold", title),
  summaryRow: (key: string, value: string): string =>
    `${styleText("bold", key)}: ${styleText("dim", value)}`,
  toolCall: (text: string): string => styleText("dim", text),
};

export const ClackDisplay = {
  layer: Layer.succeed(Display, {
    intro: (title) =>
      Effect.sync(() => clack.intro(styleText("inverse", ` ${title} `))),

    status: (message, severity) =>
      Effect.sync(() =>
        severityToClack[severity](terminalStyle.status(message)),
      ),

    spinner: (message, effect) =>
      Effect.acquireUseRelease(
        Effect.sync(() => {
          const s = clack.spinner();
          s.start(message);
          return s;
        }),
        () => effect,
        (s, exit) =>
          Effect.sync(() => {
            if (exit._tag === "Success") {
              s.stop(message);
            } else {
              s.stop(`${message} (failed)`);
            }
          }),
      ),

    summary: (title, rows) =>
      Effect.sync(() => {
        const lines = Object.entries(rows)
          .map(([key, value]) => terminalStyle.summaryRow(key, value))
          .join("\n");
        clack.note(lines, terminalStyle.summaryTitle(title));
      }),

    taskLog: (title, effect) =>
      Effect.acquireUseRelease(
        Effect.sync(() => clack.taskLog({ title })),
        (log) => effect((msg) => log.message(msg)),
        (log, exit) =>
          Effect.sync(() => {
            if (exit._tag === "Success") {
              log.success(title, { showLog: true });
            } else {
              log.error(title, { showLog: true });
            }
          }),
      ),

    text: (message) => Effect.sync(() => clack.log.message(message)),

    toolCall: (name, formattedArgs) =>
      Effect.sync(() =>
        clack.log.step(terminalStyle.toolCall(`${name}(${formattedArgs})`)),
      ),
  }),
};
