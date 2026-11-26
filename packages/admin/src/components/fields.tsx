import { forwardRef, type InputHTMLAttributes, type ReactNode, useId, useState } from "react";
import { useIntl } from "react-intl";
import { GrowingText } from "./GrowingText.tsx";

const inputClass =
  "min-h-11 w-full rounded-xl border border-edge bg-field px-3 text-lg placeholder:text-muted focus-visible:outline-3 focus-visible:outline-brand";

/** Around one of a few choices, with its radio button in it. */
export const optionClass =
  "relative flex min-h-11 cursor-pointer items-start gap-3 rounded-2xl border border-edge bg-surface p-3.5 [overflow-wrap:anywhere] has-checked:border-brand has-checked:bg-mint has-checked:ring-1 has-checked:ring-brand has-focus-visible:outline-3 has-focus-visible:outline-offset-2 has-focus-visible:outline-brand has-disabled:cursor-default";
export const radioClass = "mt-0.5 size-5 shrink-0 accent-brand outline-none";

interface FieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  hint?: ReactNode;
  error?: string | undefined;
  /** Sits beside the input, such as the password's Show button. */
  trailing?: ReactNode;
}

/** A labelled input with its hint and error wired up for screen readers. */
export const Field = forwardRef<HTMLInputElement, FieldProps>(function Field(
  { label, hint, error, trailing, ...input },
  ref,
) {
  const inputId = useId();
  const hintId = useId();
  const errorId = useId();
  return (
    <div className="grid gap-2">
      <label htmlFor={inputId} className="font-medium">
        {label}
      </label>
      <div className="flex gap-2">
        <input
          ref={ref}
          id={inputId}
          aria-describedby={hint ? `${hintId} ${errorId}` : errorId}
          aria-invalid={error ? true : undefined}
          className={inputClass}
          {...input}
        />
        {trailing}
      </div>
      {hint && (
        <p id={hintId} className="text-sm text-muted">
          {hint}
        </p>
      )}
      {/*
        Always mounted and never display:none, so aria-describedby always points at
        something, and screen readers announce it when text arrives. People usually
        press Enter inside the field, so moving focus wouldn't announce anything.
      */}
      <p id={errorId} role="alert" className="text-sm font-medium text-danger empty:sr-only">
        {error}
      </p>
    </div>
  );
});

/** The same for a sentence or two: the box grows with them. */
export function SentenceField({
  label,
  hint,
  value,
  onChange,
  ...input
}: {
  label: string;
  hint: ReactNode;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  maxLength: number;
  readOnly: boolean;
}) {
  const inputId = useId();
  const hintId = useId();
  return (
    <div className="grid gap-2">
      <label htmlFor={inputId} className="font-medium">
        {label}
      </label>
      <GrowingText
        id={inputId}
        aria-describedby={hintId}
        value={value}
        onChange={onChange}
        boxClassName="tend-grow-field"
        className="rounded-xl border border-edge bg-field placeholder:text-muted focus-visible:outline-3 focus-visible:outline-brand"
        {...input}
      />
      <p id={hintId} className="text-sm text-muted">
        {hint}
      </p>
    </div>
  );
}

interface PasswordFieldProps extends Omit<FieldProps, "type" | "trailing"> {
  /** Lets a parent reveal the password, as Suggest a passphrase does. */
  visible?: boolean;
  onVisibleChange?: (visible: boolean) => void;
}

export const PasswordField = forwardRef<HTMLInputElement, PasswordFieldProps>(
  function PasswordField({ visible, onVisibleChange, ...field }, ref) {
    const intl = useIntl();
    const [ownVisible, setOwnVisible] = useState(false);
    const shown = visible ?? ownVisible;
    return (
      <Field
        ref={ref}
        type={shown ? "text" : "password"}
        // Keeps phones from "correcting" a revealed password.
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        {...field}
        trailing={
          <button
            type="button"
            aria-label={intl.formatMessage({
              id: shown ? "common.hidePassword" : "common.showPassword",
            })}
            onClick={() => {
              setOwnVisible(!shown);
              onVisibleChange?.(!shown);
            }}
            className="min-h-11 min-w-18 shrink-0 rounded-xl border border-line bg-surface px-3 font-semibold whitespace-nowrap shadow-xs hover:border-brand focus-visible:outline-3 focus-visible:outline-brand"
          >
            {intl.formatMessage({ id: shown ? "common.hide" : "common.show" })}
          </button>
        }
      />
    );
  },
);
