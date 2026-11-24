import type { ReactNode } from "react";

export function Mono({ children, muted }: { children: ReactNode; muted?: boolean }) {
  return <span className={muted ? "mono muted" : "mono"}>{children}</span>;
}

/** One hairline-ruled key/value row. */
export function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="row">
      <div>{label}</div>
      <div className="row-value">{children}</div>
    </div>
  );
}

export function Table({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section className="table" aria-label={label}>
      <div className="table-head">
        <Mono>{label}</Mono>
      </div>
      {children}
    </section>
  );
}

/** Comma-separated typographic choice, like the nav: active black, rest gray. */
export function Choice<T extends string>(props: {
  label: string;
  value: T;
  options: readonly T[];
  onChange: (value: T) => void;
}) {
  return (
    <span role="group" aria-label={props.label}>
      {props.options.map((option, i) => (
        <span key={option}>
          <button
            type="button"
            className="choice"
            aria-pressed={option === props.value}
            onClick={() => props.onChange(option)}
          >
            {option}
          </button>
          {i < props.options.length - 1 && <span className="muted">, </span>}
        </span>
      ))}
    </span>
  );
}
