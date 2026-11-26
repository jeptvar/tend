import { forwardRef, type TextareaHTMLAttributes } from "react";
import { isComposing } from "../lib/keys.ts";

interface GrowingTextProps
  extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "value" | "onChange" | "rows"> {
  value: string;
  onChange: (value: string) => void;
  /** For the box around it, which says how big the words are. */
  boxClassName?: string;
}

/**
 * A box for a line or two that grows with what's in it, rather than hiding the end of it. It's
 * still one line as far as what's kept goes: a line break that's pasted in becomes a space.
 */
export const GrowingText = forwardRef<HTMLTextAreaElement, GrowingTextProps>(function GrowingText(
  { value, onChange, boxClassName = "", className = "", onKeyDown, ...input },
  ref,
) {
  return (
    <div className={`tend-grow ${boxClassName}`} data-words={value || input.placeholder}>
      <textarea
        ref={ref}
        rows={1}
        value={value}
        onChange={(event) => onChange(event.target.value.replace(/\s*[\r\n]+\s*/g, " "))}
        onKeyDown={(event) => {
          onKeyDown?.(event);
          if (event.key === "Enter" && !isComposing(event)) event.preventDefault();
        }}
        className={className}
        {...input}
      />
    </div>
  );
});
