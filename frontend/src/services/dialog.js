let dialog
const subscriptions = []

/**
 * @typedef {Object} DialogOptions
 * @param {string} header The dialog title
 * @param {string} kind The dialog kind (optional)
 * @param {string} text The dialog text
 * @param {string} html The dialog html (instead of text)
 * @param {string} confirmLabel The dialog confirm button label
 */

export default {
    // bind this service to a ff-dialog element
    // this is used in Platform.vue in order to control the showing/hiding
    // of the app's main dialog
    bind: function (el, fcn) {
        dialog = el
        subscriptions.push(fcn)
    },

    /**
     * Show a dialog
     * @param {string|DialogOptions} msg The dialog message or a DialogOptions object
     * @param {Function} onConfirm A callback function to call when the confirm button is clicked
     * @param {Function} onCancel (optional) A callback function to call when the cancel button is clicked
     * @example
     * // show a simple dialog
     * dialogService.show('Are you sure?', () => { console.log('confirmed') })
     * @example
     * // show a dialog with a custom header and confirm button label
     * dialogService.show({
     *    header: 'Are you sure?',
     *    text: 'This action cannot be undone',
     *    confirmLabel: 'Yes, I am sure'
     * }, () => { console.log('confirmed') })
     */
    show: async function (msg, onConfirm, onCancel) {
        for (let fcn = 0; fcn < subscriptions.length; fcn++) {
            subscriptions[fcn](msg, onConfirm, onCancel)
        }
        dialog.show()
    },

    /**
     * Show a dialog and return a promise that resolves when the dialog is closed
     * @param {string|DialogOptions} msg The dialog message or a DialogOptions object
     * @example
     * // show a simple dialog
     * const result = await dialogService.showAsync('Are you sure?')
     * if (result === 'confirm') {
     *   console.log('confirmed')
     * } else {
     *  console.log('cancelled')
     * }
     * @example
     * // show a dialog with a custom header and confirm button label
     * const result = await dialogService.showAsync({
     *   header: 'Are you sure?',
     *   text: 'This action cannot be undone',
     *   confirmLabel: 'Yes, I am sure'
     * })
     * if (result === 'confirm') {
     *   console.log('confirmed')
     * } else {
     *   console.log('cancelled')
     * }
     */
    showAsync: function (msg) {
        return new Promise((resolve, _reject) => {
            this.show(msg, () => {
                resolve('confirm')
            }, () => {
                resolve('cancel')
            })
        })
    }
}
