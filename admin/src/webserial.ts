/** Shown when the browser has no WebSerial at all (Firefox, Safari). */
export const WEBSERIAL_UNSUPPORTED = 'WebSerial is not supported by this browser (Chrome/Edge required)';

/** Shown when the browser has WebSerial but hides it, because the page is not in a secure context. */
export const WEBSERIAL_INSECURE =
    'WebSerial needs a secure connection. Open the ioBroker admin over HTTPS or on localhost, or use "Download image" and flash the image with the web flasher of Espressif (espressif.github.io/esptool-js).';

/**
 * The text (an i18n key) for a missing `navigator.serial`. Chrome and Edge only offer it in a secure
 * context, so a page opened over plain HTTP gets told so instead of that its browser is the wrong one.
 *
 * @param secureContext - `window.isSecureContext`
 */
export function missingWebSerialMessage(secureContext: boolean | undefined): string {
    return secureContext === false ? WEBSERIAL_INSECURE : WEBSERIAL_UNSUPPORTED;
}
