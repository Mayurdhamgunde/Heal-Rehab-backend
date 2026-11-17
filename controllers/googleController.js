const getLastUpdatedInfo = async (req, res) => {
  try {
    // We already have access to orgDb and user info from authenticateToken middleware
    const { orgDb, user } = req;

    const orgSettings = await orgDb
      .collection("organization_settings")
      .findOne(
        { tenant_id: user.tenant_id },
        { projection: { last_updated: 1, updated_by: 1, _id: 0 } }
      );

    if (!orgSettings) {
      return res.status(404).json({
        error: "No organization settings found",
      });
    }

    return res.status(200).json({
      lastUpdated: orgSettings.last_updated,
      updatedBy: orgSettings.updated_by,
      organization_name: user.organization_name,
      doctor_name: `${user.doctor_first_name} ${user.doctor_last_name}`,
    });
  } catch (error) {
    console.error("Error getting last updated info:", error);
    return res.status(500).json({
      error: "Failed to retrieve last updated information",
    });
  }
};
module.exports = { getLastUpdatedInfo };
