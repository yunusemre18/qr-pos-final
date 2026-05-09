const mongoose = require('mongoose');

const OrderSchema = new mongoose.Schema({
  tableNo: Number,
  productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product' },
  quantity: Number,
  price: Number,
  note: String,
  status: { type: String, default: 'Received' },
  isDelivered: { type: Boolean, default: false },
  addedBy: { type: String, default: 'Customer' },
  date: { type: Date, default: Date.now },
  isPaid: { type: Boolean, default: false },
  paymentRequested: { type: Boolean, default: false },
  paymentType: { type: String, default: null },
  splitType: String,
  personCount: Number,
  paymentMethods: [String],
  personIndex: Number
}, { collection: 'orders' });

module.exports = mongoose.model('Order', OrderSchema);