const { Op } = require('sequelize')

const { ControllerError } = require('../../../lib/errors')
class DeviceGroupMembershipValidationError extends ControllerError {
    /**
     * @param {string} code
     * @param {string} message
     * @param {number} statusCode
     * @param {Object} options
     */
    constructor (code, message, statusCode, options) {
        super(code, message, statusCode, options)
        this.name = 'DeviceGroupMembershipValidationError'
    }
}

module.exports = {

    /**
     * Create a Device Group
     * @param {import("../../../forge").ForgeApplication} app The application object
     * @param {string} name The name of the Device Group
     * @param {Object} options
     * @param {Object} [options.application] The application this Device Group will belong to
     * @param {string} [options.description] The description of the Device Group
     * @returns {Promise<Object>} The created Device Group
     */
    createDeviceGroup: async function (app, name, { application = null, description } = {}) {
        // Create a Device Group that devices can be linked to
        // * name is required
        // * application, description are optional
        // * FUTURE: colors (background, border, text) and icon will be optional

        return await app.db.models.DeviceGroup.create({
            name,
            description,
            ApplicationId: application?.id
        })
    },

    updateDeviceGroup: async function (app, deviceGroup, { name = undefined, description = undefined } = {}) {
        // * deviceGroup is required.
        // * name, description, color are optional
        if (!deviceGroup) {
            throw new Error('DeviceGroup is required')
        }
        let changed = false
        if (typeof name !== 'undefined') {
            deviceGroup.name = name
            changed = true
        }
        if (typeof description !== 'undefined') {
            deviceGroup.description = description
            changed = true
        }
        if (changed) {
            await deviceGroup.save()
            await deviceGroup.reload()
        }
        return deviceGroup
    },

    updateDeviceGroupMembership: async function (app, deviceGroup, { addDevices, removeDevices, setDevices } = {}) {
        // * deviceGroup is required. The object must be a Sequelize model instance and must include the Devices
        // * addDevices, removeDevices, setDevices are optional
        // * if setDevices is provided, this will be used to set the devices assigned to the group, removing any devices that are not in the set
        // * if addDevices is provided, these devices will be added to the group
        // * if removeDevices is provided, these devices will be removed from the group
        // if a device appears in both addDevices and removeDevices, it will be removed from the group (remove occurs after add)
        if (!setDevices && !addDevices && !removeDevices) {
            return // nothing to do
        }
        if (!deviceGroup || typeof deviceGroup !== 'object') {
            throw new Error('DeviceGroup is required')
        }
        let actualRemoveDevices = []
        let actualAddDevices = []
        const currentMembers = await deviceGroup.getDevices()
        // from this point on, all IDs need to be numeric (convert as needed)
        const currentMemberIds = deviceListToIds(currentMembers, app.db.models.Device.decodeHashid)
        setDevices = setDevices && deviceListToIds(setDevices, app.db.models.Device.decodeHashid)
        addDevices = addDevices && deviceListToIds(addDevices, app.db.models.Device.decodeHashid)
        removeDevices = removeDevices && deviceListToIds(removeDevices, app.db.models.Device.decodeHashid)

        // setDevices is an atomic operation, it will replace the current list of devices with the specified list
        if (typeof setDevices !== 'undefined') {
            // create a list of devices that are currently assigned to the group, minus the devices in the set, these are the ones to remove
            actualRemoveDevices = currentMemberIds.filter(d => !setDevices.includes(d))
            // create a list of devices that are in the set, minus the devices that are currently assigned to the group, these are the ones to add
            actualAddDevices = setDevices.filter(d => !currentMemberIds.includes(d))
        } else {
            if (typeof removeDevices !== 'undefined') {
                actualRemoveDevices = currentMemberIds.filter(d => removeDevices.includes(d))
            }
            if (typeof addDevices !== 'undefined') {
                actualAddDevices = addDevices.filter(d => !currentMemberIds.includes(d))
            }
        }

        // wrap the dual operation in a transaction to avoid inconsistent state
        const t = await app.db.sequelize.transaction()
        try {
            // add devices
            if (actualAddDevices.length > 0) {
                await this.assignDevicesToGroup(app, deviceGroup, actualAddDevices, t)
            }
            // remove devices
            if (actualRemoveDevices.length > 0) {
                await this.removeDevicesFromGroup(app, deviceGroup, actualRemoveDevices, t)
            }
            // commit the transaction
            await t.commit()
        } catch (err) {
            // Rollback transaction if any errors were encountered
            await t.rollback()
            // if the error is a DeviceGroupMembershipValidationError, rethrow it
            if (err instanceof DeviceGroupMembershipValidationError) {
                throw err
            }
            // otherwise, throw a friendly error message along with the original error
            throw new Error(`Failed to update device group membership: ${err.message}`)
        }
    },

    assignDevicesToGroup: async function (app, deviceGroup, deviceList, transaction = null) {
        const deviceIds = await validateDeviceList(app, deviceGroup, deviceList, null)
        await app.db.models.Device.update({ DeviceGroupId: deviceGroup.id }, { where: { id: deviceIds.addList }, transaction })
    },

    /**
     * Remove 1 or more devices from the specified DeviceGroup
     * @param {*} app The application object
     * @param {*} deviceGroupId The device group id
     * @param {*} deviceList A list of devices to remove from the group
     */
    removeDevicesFromGroup: async function (app, deviceGroup, deviceList, transaction = null) {
        const deviceIds = await validateDeviceList(app, deviceGroup, null, deviceList)
        // null every device.DeviceGroupId row in device table where the id === deviceGroupId and device.id is in the deviceList
        await app.db.models.Device.update({ DeviceGroupId: null }, { where: { id: deviceIds.removeList, DeviceGroupId: deviceGroup.id }, transaction })
    },
    /**
     * Sends the project id, snapshot hash and settings hash to all devices in the group
     * so that they can determine what/if it needs to update
     * NOTE: Only devices belonging to an application are present in a device group
     * @param {forge.db.models.DeviceGroup} deviceGroup The device group to send an "update" command to
     */
    sendUpdateCommand: async function (app, deviceGroup) {
        if (app.comms) {
            const application = await deviceGroup.getApplication({ include: [{ model: app.db.models.Team }] })
            const targetSnapshot = deviceGroup.targetSnapshot || (await app.db.models.ProjectSnapshot.byId(deviceGroup.PipelineStageDeviceGroup.targetSnapshotId))
            const payloadTemplate = {
                ownerType: 'application',
                application: application.hashid,
                snapshot: targetSnapshot.hashid,
                settings: null,
                mode: null,
                licensed: app.license.active()
            }
            const devices = await deviceGroup.getDevices()
            for (const device of devices) {
                // If the device doesnt have the same target snapshot as the group, skip it
                if (device.targetSnapshotId !== deviceGroup.PipelineStageDeviceGroup.targetSnapshotId) {
                    continue
                }
                const payload = { ...payloadTemplate }
                payload.settings = device.settingsHash || null
                payload.mode = device.mode
                app.comms.devices.sendCommand(application.Team.hashid, device.hashid, 'update', payload)
            }
        }
    },
    DeviceGroupMembershipValidationError
}

/**
 * Convert a list of devices to a list of device ids
 * @param {Object[]|String[]|Number[]} deviceList List of devices to convert to ids
 * @param {Function} decoderFn The decoder function to use on hashes
 * @returns {Number[]} Array of device IDs
 */
function deviceListToIds (deviceList, decoderFn) {
    // Convert a list of devices (object|id|hash) to a list of device ids
    const ids = deviceList?.map(device => {
        let id = device
        if (typeof device === 'string') {
            [id] = decoderFn(device)
        } else if (typeof device === 'object') {
            id = device.id
        }
        return id
    })
    return ids
}

/**
 * Verify devices are suitable for the specified group:
 *
 * * All devices in the list must either have DeviceGroupId===null or DeviceGroupId===deviceGroupId
 * * All devices in the list must belong to the same Application as the DeviceGroup
 * * All devices in the list must belong to the same Team as the DeviceGroup
 * @param {*} app The application object
 * @param {*} deviceGroupId The device group id
 * @param {*} deviceList A list of devices to verify
 */
async function validateDeviceList (app, deviceGroup, addList, removeList) {
    // check to ensure all devices in deviceList are not assigned to any group before commencing
    // Assign 1 or more devices to a DeviceGroup
    if (!deviceGroup || typeof deviceGroup !== 'object') {
        throw new Error('DeviceGroup is required')
    }

    // reload with the Application association if not already loaded
    if (!deviceGroup.Application) {
        await deviceGroup.reload({ include: [{ model: app.db.models.Application }] })
    }

    const teamId = deviceGroup.Application.TeamId
    if (!teamId) {
        throw new Error('DeviceGroup must belong to an Application that belongs to a Team')
    }

    const deviceIds = {
        addList: addList && deviceListToIds(addList, app.db.models.Device.decodeHashid),
        removeList: removeList && deviceListToIds(removeList, app.db.models.Device.decodeHashid)
    }
    const deviceGroupId = deviceGroup.id
    if (deviceIds.addList) {
        const okCount = await app.db.models.Device.count({
            where: {
                id: deviceIds.addList,
                [Op.or]: [
                    { DeviceGroupId: null },
                    { DeviceGroupId: deviceGroupId }
                ],
                ApplicationId: deviceGroup.ApplicationId,
                TeamId: teamId
            }
        })
        if (okCount !== deviceIds.addList.length) {
            throw new DeviceGroupMembershipValidationError('invalid_input', 'One or more devices cannot be added to the group', 400)
        }
    }
    if (deviceIds.removeList) {
        const okCount = await app.db.models.Device.count({
            where: {
                id: deviceIds.removeList,
                DeviceGroupId: deviceGroupId,
                ApplicationId: deviceGroup.ApplicationId,
                TeamId: teamId
            }
        })
        if (okCount !== deviceIds.removeList.length) {
            throw new DeviceGroupMembershipValidationError('invalid_input', 'One or more devices cannot be removed from the group', 400)
        }
    }
    return deviceIds
}