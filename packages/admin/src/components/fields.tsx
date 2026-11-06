import { forwardRef, type InputHTMLAttributes, type ReactNode, useId, useState } from "react";
import { useIntl } from "react-intl";

const inputClass =
  "min-h-11 w-full rounded-lg border border-muted bg-white px-3 text-lg text-[#1d2420] placeholder:text-[#5b655f] focus-visible:outline-3 focus-visible:outline-brand";

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
            className="min-h-11 min-w-16 rounded-lg border border-muted px-3 font-medium hover:border-brand focus-visible:outline-3 focus-visible:outline-brand"
          >
            {intl.formatMessage({ id: shown ? "common.hide" : "common.show" })}
          </button>
        }
      />
    );
  },
);
