const mongoose = require("mongoose");

const TableSchema = new mongoose.Schema({
    tableNo: { type: Number, required: true, unique: true },
    total: { type: Number, default: 0 },
    calledWaiter: { type: Boolean, default: false },
    isConnected: { type: Boolean, default: false }
});

module.exports = mongoose.model("Table", TableSchema);