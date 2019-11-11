/**
 * Default configs.
 */
const DEFAULT_DELIMITER = "/";

/**
 * The main path matching regexp utility.
 */
const PATH_REGEXP = new RegExp(
  [
    // Match escaped characters that would otherwise appear in future matches.
    // This allows the user to escape special characters that won't transform.
    "(\\\\.)",
    // Match Express-style parameters and un-named parameters with a prefix
    // and optional suffixes. Matches appear as:
    //
    // ":test(\\d+)?" => ["test", "\d+", undefined, "?"]
    // "(\\d+)"  => [undefined, undefined, "\d+", undefined]
    "(?:\\:(\\w+)(?:\\(((?:\\\\.|[^\\\\()])+)\\))?|\\(((?:\\\\.|[^\\\\()])+)\\))([+*?])?"
  ].join("|"),
  "g"
);

export interface ParseOptions {
  /**
   * Set the default delimiter for repeat parameters. (default: `'/'`)
   */
  delimiter?: string;
  /**
   * List of characters to consider delimiters when parsing. (default: `undefined`, any character)
   */
  whitelist?: string | string[];
}

/**
 * Parse a string for the raw tokens.
 */
export function parse(str: string, options: ParseOptions = {}): Token[] {
  const tokens = [];
  const defaultDelimiter = options.delimiter ?? DEFAULT_DELIMITER;
  const whitelist = options.whitelist ?? undefined;
  let key = 0;
  let index = 0;
  let path = "";
  let isPathEscaped = false;
  let res: RegExpExecArray | null;

  // tslint:disable-next-line
  while ((res = PATH_REGEXP.exec(str)) !== null) {
    const [m, escaped, name, capture, group, modifier] = res;
    let prev = "";

    path += str.slice(index, res.index);
    index = res.index + m.length;

    // Ignore already escaped sequences.
    if (escaped) {
      path += escaped[1];
      isPathEscaped = true;
      continue;
    }

    if (!isPathEscaped && path.length) {
      const k = path.length - 1;
      const c = path[k];
      const matches = whitelist ? whitelist.indexOf(c) > -1 : true;

      if (matches) {
        prev = c;
        path = path.slice(0, k);
      }
    }

    // Push the current path onto the tokens.
    if (path) {
      tokens.push(path);
      path = "";
      isPathEscaped = false;
    }

    const repeat = modifier === "+" || modifier === "*";
    const optional = modifier === "?" || modifier === "*";
    const pattern = capture || group;
    const delimiter = prev || defaultDelimiter;

    tokens.push({
      name: name || key++,
      prefix: prev,
      delimiter: delimiter,
      optional: optional,
      repeat: repeat,
      pattern: pattern
        ? escapeGroup(pattern)
        : `[^${escapeString(
            delimiter === defaultDelimiter
              ? delimiter
              : delimiter + defaultDelimiter
          )}]+?`
    });
  }

  // Push any remaining characters.
  if (path || index < str.length) {
    tokens.push(path + str.substr(index));
  }

  return tokens;
}

export interface TokensToFunctionOptions {
  /**
   * When `true` the regexp will be case sensitive. (default: `false`)
   */
  sensitive?: boolean;
  /**
   * Function for encoding input strings for output.
   */
  encode?: (value: string, token: Key) => string;
  /**
   * When `false` the function can produce an invalid (unmatched) path. (default: `true`)
   */
  validate?: boolean;
}

/**
 * Compile a string to a template function for the path.
 */
export function compile<P extends object = object>(
  str: string,
  options?: ParseOptions & TokensToFunctionOptions
) {
  return tokensToFunction<P>(parse(str, options), options);
}

export type PathFunction<P extends object = object> = (data?: P) => string;

/**
 * Expose a method for transforming tokens into the path function.
 */
export function tokensToFunction<P extends object = object>(
  tokens: Token[],
  options: TokensToFunctionOptions = {}
): PathFunction<P> {
  const reFlags = flags(options);
  const { encode = encodeURIComponent, validate = true } = options;

  // Compile all the tokens into regexps.
  const matches = tokens.map(token => {
    if (typeof token === "object") {
      return new RegExp(`^(?:${token.pattern})$`, reFlags);
    }
  });

  return (data: Record<string, any> | null | undefined) => {
    let path = "";

    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];

      if (typeof token === "string") {
        path += token;
        continue;
      }

      const value = data ? data[token.name] : undefined;

      if (Array.isArray(value)) {
        if (!token.repeat) {
          throw new TypeError(
            `Expected "${token.name}" to not repeat, but got an array`
          );
        }

        if (value.length === 0) {
          if (token.optional) continue;

          throw new TypeError(`Expected "${token.name}" to not be empty`);
        }

        for (let j = 0; j < value.length; j++) {
          const segment = encode(value[j], token);

          if (validate && !(matches[i] as RegExp).test(segment)) {
            throw new TypeError(
              `Expected all "${token.name}" to match "${token.pattern}", but got "${segment}"`
            );
          }

          path += (j === 0 ? token.prefix : token.delimiter) + segment;
        }

        continue;
      }

      if (typeof value === "string" || typeof value === "number") {
        const segment = encode(String(value), token);

        if (validate && !(matches[i] as RegExp).test(segment)) {
          throw new TypeError(
            `Expected "${token.name}" to match "${token.pattern}", but got "${segment}"`
          );
        }

        path += token.prefix + segment;
        continue;
      }

      if (token.optional) continue;

      const typeOfMessage = token.repeat ? "an array" : "a string";
      throw new TypeError(`Expected "${token.name}" to be ${typeOfMessage}`);
    }

    return path;
  };
}

export interface RegexpToFunctionOptions {
  /**
   * Function for decoding strings for params.
   */
  decode?: (value: string, token: Key) => string;
}

/**
 * A match result contains data about the path match.
 */
export interface MatchResult<P extends object = object> {
  path: string;
  index: number;
  params: P;
}

/**
 * A match is either `false` (no match) or a match result.
 */
export type Match<P extends object = object> = false | MatchResult<P>;

/**
 * The match function takes a string and returns whether it matched the path.
 */
export type MatchFunction<P extends object = object> = (
  path: string
) => Match<P>;

/**
 * Create path match function from `path-to-regexp` spec.
 */
export function match<P extends object = object>(
  str: Path,
  options?: ParseOptions & RegexpToFunctionOptions
) {
  const keys: Key[] = [];
  const re = pathToRegexp(str, keys, options);
  return regexpToFunction<P>(re, keys);
}

/**
 * Create a path match function from `path-to-regexp` output.
 */
export function regexpToFunction<P extends object = object>(
  re: RegExp,
  keys: Key[],
  options: RegexpToFunctionOptions = {}
): MatchFunction<P> {
  const { decode = decodeURIComponent } = options;

  return function(pathname: string) {
    const m = re.exec(pathname);
    if (!m) return false;

    const { 0: path, index } = m;
    const params = Object.create(null);

    for (let i = 1; i < m.length; i++) {
      // tslint:disable-next-line
      if (m[i] === undefined) continue;

      const key = keys[i - 1];

      if (key.repeat) {
        params[key.name] = m[i].split(key.delimiter).map(value => {
          return decode(value, key);
        });
      } else {
        params[key.name] = decode(m[i], key);
      }
    }

    return { path, index, params };
  };
}

/**
 * Escape a regular expression string.
 */
function escapeString(str: string) {
  return str.replace(/([.+*?=^!:${}()[\]|/\\])/g, "\\$1");
}

/**
 * Escape the capturing group by escaping special characters and meaning.
 */
function escapeGroup(group: string) {
  return group.replace(/([=!:$/()])/g, "\\$1");
}

/**
 * Get the flags for a regexp from the options.
 */
function flags(options?: { sensitive?: boolean }) {
  return options && options.sensitive ? "" : "i";
}

/**
 * Metadata about a key.
 */
export interface Key {
  name: string | number;
  prefix: string;
  delimiter: string;
  optional: boolean;
  repeat: boolean;
  pattern: string;
}

/**
 * A token is a string (nothing special) or key metadata (capture group).
 */
export type Token = string | Key;

/**
 * Pull out keys from a regexp.
 */
function regexpToRegexp(path: RegExp, keys?: Key[]): RegExp {
  if (!keys) return path;

  // Use a negative lookahead to match only capturing groups.
  const groups = path.source.match(/\((?!\?)/g);

  if (groups) {
    for (let i = 0; i < groups.length; i++) {
      keys.push({
        name: i,
        prefix: "",
        delimiter: "",
        optional: false,
        repeat: false,
        pattern: ""
      });
    }
  }

  return path;
}

/**
 * Transform an array into a regexp.
 */
function arrayToRegexp(
  paths: Array<string | RegExp>,
  keys?: Key[],
  options?: RegExpOptions & ParseOptions
): RegExp {
  const parts = paths.map(path => pathToRegexp(path, keys, options).source);
  return new RegExp(`(?:${parts.join("|")})`, flags(options));
}

/**
 * Create a path regexp from string input.
 */
function stringToRegexp(
  path: string,
  keys?: Key[],
  options?: RegExpOptions & ParseOptions
) {
  return tokensToRegExp(parse(path, options), keys, options);
}

/**
 * Expose a function for taking tokens and returning a RegExp.
 */
export function tokensToRegExp(
  tokens: Token[],
  keys?: Key[],
  options: RegExpOptions = {}
) {
  const {
    strict,
    start = true,
    end = true,
    delimiter = DEFAULT_DELIMITER
  } = options;
  const endsWith = (typeof options.endsWith === "string"
    ? options.endsWith.split("")
    : options.endsWith || []
  )
    .map(escapeString)
    .concat("$")
    .join("|");
  let route = start ? "^" : "";

  // Iterate over the tokens and create our regexp string.
  for (const token of tokens) {
    if (typeof token === "string") {
      route += escapeString(token);
    } else {
      const capture = token.repeat
        ? `(?:${token.pattern})(?:${escapeString(token.delimiter)}(?:${
            token.pattern
          }))*`
        : token.pattern;

      if (keys) keys.push(token);

      if (token.optional) {
        if (!token.prefix) {
          route += `(${capture})?`;
        } else {
          route += `(?:${escapeString(token.prefix)}(${capture}))?`;
        }
      } else {
        route += `${escapeString(token.prefix)}(${capture})`;
      }
    }
  }

  if (end) {
    if (!strict) route += `(?:${escapeString(delimiter)})?`;

    route += endsWith === "$" ? "$" : `(?=${endsWith})`;
  } else {
    const endToken = tokens[tokens.length - 1];
    const isEndDelimited =
      typeof endToken === "string"
        ? endToken[endToken.length - 1] === delimiter
        : // tslint:disable-next-line
          endToken === undefined;

    if (!strict) {
      route += `(?:${escapeString(delimiter)}(?=${endsWith}))?`;
    }

    if (!isEndDelimited) {
      route += `(?=${escapeString(delimiter)}|${endsWith})`;
    }
  }

  return new RegExp(route, flags(options));
}

export interface RegExpOptions {
  /**
   * When `true` the regexp will be case sensitive. (default: `false`)
   */
  sensitive?: boolean;
  /**
   * When `true` the regexp allows an optional trailing delimiter to match. (default: `false`)
   */
  strict?: boolean;
  /**
   * When `true` the regexp will match to the end of the string. (default: `true`)
   */
  end?: boolean;
  /**
   * When `true` the regexp will match from the beginning of the string. (default: `true`)
   */
  start?: boolean;
  /**
   * Sets the final character for non-ending optimistic matches. (default: `/`)
   */
  delimiter?: string;
  /**
   * List of characters that can also be "end" characters.
   */
  endsWith?: string | string[];
}

export interface ParseOptions {
  /**
   * Set the default delimiter for repeat parameters. (default: `'/'`)
   */
  delimiter?: string;
}

/**
 * Supported `path-to-regexp` input types.
 */
export type Path = string | RegExp | Array<string | RegExp>;

/**
 * Normalize the given path string, returning a regular expression.
 *
 * An empty array can be passed in for the keys, which will hold the
 * placeholder key descriptions. For example, using `/user/:id`, `keys` will
 * contain `[{ name: 'id', delimiter: '/', optional: false, repeat: false }]`.
 */
export function pathToRegexp(
  path: Path,
  keys?: Key[],
  options?: RegExpOptions & ParseOptions
) {
  if (path instanceof RegExp) {
    return regexpToRegexp(path, keys);
  }

  if (Array.isArray(path)) {
    return arrayToRegexp(path, keys, options);
  }

  return stringToRegexp(path, keys, options);
}