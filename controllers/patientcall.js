const express = require("express");
const axios = require("axios");
require("dotenv").config();
const { Therepy } = require("../db/therepy");
const { Patient } = require("../db/patientSchema");

const call = async (req, res) => {
  try {
    const Convo = req.body;
    const url = `https://ls-sbx-integration-app-cus-001.azurewebsites.net/api/v1/Contact/Conversations/Create`;
    headers = {
      Authorization: process.env.Token,
      "x-organization-id": process.env.x_organization_id,
      Accept: "application/json",
      "Content-Type": "application/json",
    };
    const response = await axios.post(url, Convo, { headers });

    const responseData = {
      Id: response.data.Id,
      Type: response.data.Type,
      HostJoinUrl: response.data.HostJoinUrl,
      ParticipantJoinUrl: response.data.ParticipantJoinUrl,
      ConversationUrl: response.data.ConversationUrl,
    };

    const newTherepy = await Therepy.create({
      patient_id: Convo.contactId,
      therepy_id: responseData.Id,
      therepy_type: Convo.therepy_type,
      therepy_remarks: Convo.remarks,
      therepy_link: responseData.ConversationUrl,
    });
    const patient = await Patient.findOne({ patient_id: Convo.contactId });
    patient.therepys.push(newTherepy._id);
    await patient.save();
    console.log(responseData);
    return res.status(200).json(responseData);
  } catch (error) {
    return res.status(500).json({ message: error });
  }
};

async function createPatient(patientData, liveSwitchToken) {
  try {
    const URL = `https://public-api.production.liveswitch.com/v1/contacts`;
    const headers = {
      Authorization: `Bearer ${liveSwitchToken}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    };
    console.log(liveSwitchToken);
    const response = await axios.post(URL, patientData, { headers });
    return response.data.id; // LiveSwitch API returns 'id' instead of 'Id'
  } catch (error) {
    //console.error("Error creating patient in LiveSwitch:", error);
    throw error;
  }
}
module.exports = { call, createPatient };
