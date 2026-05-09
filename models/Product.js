const mongoose = require('mongoose');

const ProductSchema = new mongoose.Schema({
  name: String,
  price: Number,
  photo: String,
  category: String,
  mainCategory: String,
  salesCount: { type: Number, default: 0 },
  description: { type: String, default: '' },
  orderNo: { type: Number, default: 999 },
  prepLocation: { type: String, enum: ['Kitchen', 'Service'], default: 'Kitchen' },
  isActive: { type: Boolean, default: true },
  options: [
    {
      title: String,
      type: { type: String, enum: ['single', 'multiple'], default: 'single' },
      choices: [
        {
          name: String,
          extraPrice: { type: Number, default: 0 }
        }
      ]
    }
  ]
});

module.exports = mongoose.model('Product', ProductSchema);