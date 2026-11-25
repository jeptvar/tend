import { forwardRef, useId } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import { GrowingText } from "../components/GrowingText.tsx";

/** The title, written where it'll be and as it'll look: no box, and as big as a title is. */
export const TitleField = forwardRef<
  HTMLTextAreaElement,
  {
    value: string;
    onChange: (value: string) => void;
    /** Enter moves on to the writing, the same as a word processor's title. */
    onEnter: () => void;
    error: string | undefined;
    readOnly: boolean;
    autoFocus: boolean;
  }
>(function TitleField({ value, onChange, onEnter, error, readOnly, autoFocus }, ref) {
  const intl = useIntl();
  const inputId = useId();
  const errorId = useId();
  return (
    <div className="tend-title">
      <label htmlFor={inputId} className="sr-only">
        <FormattedMessage id="editor.titleLabel" />
      </label>
      <GrowingText
        ref={ref}
        id={inputId}
        value={value}
        onChange={onChange}
        onKeyDown={(event) => {
          if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
          event.preventDefault();
          onEnter();
        }}
        placeholder={intl.formatMessage({ id: "editor.titlePlaceholder" })}
        aria-describedby={errorId}
        aria-invalid={error ? true : undefined}
        maxLength={200}
        readOnly={readOnly}
        autoFocus={autoFocus}
        className="bg-transparent outline-none placeholder:text-muted"
      />
      {/* Always mounted: screen readers can miss a live region added along with its text. */}
      <p
        id={errorId}
        role="alert"
        className="mt-2 font-sans text-base font-medium tracking-normal text-danger empty:sr-only"
      >
        {error}
      </p>
    </div>
  );
});
