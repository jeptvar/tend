import { type RefObject, useState } from "react";
import { FormattedMessage, type IntlShape, useIntl } from "react-intl";
import { suggestPassphrase } from "../lib/passphrase.ts";
import { secondaryButtonClass } from "./AuthLayout.tsx";
import { PasswordField } from "./fields.tsx";

const MIN_PASSWORD_LENGTH = 12;

/** What's wrong with a new password before it's sent, if anything. */
export function tooShort(password: string, intl: IntlShape): string | undefined {
  return [...password].length < MIN_PASSWORD_LENGTH
    ? intl.formatMessage({ id: "setup.account.passwordShort" }, { min: MIN_PASSWORD_LENGTH })
    : undefined;
}

/** A new password, with a passphrase to suggest. */
export function NewPasswordField({
  inputRef,
  password,
  onChange,
  error,
  labelId,
}: {
  inputRef: RefObject<HTMLInputElement | null>;
  password: string;
  onChange: (password: string) => void;
  error: string | undefined;
  labelId: string;
}) {
  const intl = useIntl();
  const [visible, setVisible] = useState(false);
  const [suggested, setSuggested] = useState(false);
  return (
    <div className="grid gap-3">
      <PasswordField
        ref={inputRef}
        label={intl.formatMessage({ id: labelId })}
        hint={
          <FormattedMessage id="setup.account.passwordHint" values={{ min: MIN_PASSWORD_LENGTH }} />
        }
        value={password}
        onChange={(event) => {
          onChange(event.target.value);
          setSuggested(false);
        }}
        error={error}
        visible={visible}
        onVisibleChange={setVisible}
        autoComplete="new-password"
        required
      />
      <div>
        <button
          type="button"
          onClick={() => {
            onChange(suggestPassphrase());
            setVisible(true);
            setSuggested(true);
            inputRef.current?.focus();
          }}
          className={secondaryButtonClass}
        >
          <FormattedMessage id="setup.account.suggest" />
        </button>
      </div>
      {/* Always mounted: screen readers can miss a live region added along with its text. */}
      <p role="status" className="text-sm text-muted empty:sr-only">
        {suggested && <FormattedMessage id="setup.account.suggested" />}
      </p>
    </div>
  );
}
