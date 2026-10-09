import mongoose from "mongoose";

import WorkspaceProduct from "../models/workspaceProduct.model.js";
import Batch from "../models/batch.model.js";
import ProductFacility from "../models/productFacility.model.js";

import { WORKSPACE_PRODUCT_STATUS } from "../constants/workspaceProduct.constant.js";

// ---------------------
// Finders
// ---------------------

const findWorkspaceProductById = async (productId, workspaceId, options = {}) => {
  if (!mongoose.Types.ObjectId.isValid(productId)) {
    return null;
  }

  return WorkspaceProduct.findOne({
    _id: productId,
    workspaceId,
    isDeleted: false,
  })
    .populate("HsnMaster", "code description gstRate cessRate isActive")
    .populate("manufacturer", "name description isActive")
    .populate("uom", "name abbreviation description isActive")
    .populate("category", "name slug parentCategory level description imageUrl isActive")
    .populate("productForm", "name description isActive")
    .populate("composition.salt", "name description isActive")
    .select(options.select || "");
};

const findWorkspaceProductByCode = async (
  workspaceProductCode,
  workspaceId,
  options = {},
) => {
  return WorkspaceProduct.findOne({
    workspaceProductCode: String(workspaceProductCode).trim().toUpperCase(),
    workspaceId,
    isDeleted: false,
  })
    .populate("HsnMaster", "code description gstRate cessRate isActive")
    .populate("manufacturer", "name description isActive")
    .populate("uom", "name abbreviation description isActive")
    .populate("category", "name slug parentCategory level description imageUrl isActive")
    .populate("productForm", "name description isActive")
    .populate("composition.salt", "name description isActive")
    .select(options.select || "");
};

const findWorkspaceProductByName = async (name, workspaceId, options = {}) => {
  return WorkspaceProduct.findOne({
    name: { $regex: new RegExp(`^${String(name).trim()}$`, "i") },
    workspaceId,
    isDeleted: false,
  }).select(options.select || "");
};

// ---------------------
// List / Search
// ---------------------

/**
 * Paginated list of workspace products scoped to a single workspace.
 *
 * Supported filters:
 *   status      — active | inactive
 *   productType — medicine | otc
 *   search      — name search (case-insensitive regex)
 */
const getWorkspaceProducts = async (
  workspaceId,
  filters = {},
  options = {},
) => {
  const query = {
    workspaceId,
    isDeleted: false,
  };

  if (filters.status) {
    query.status = filters.status;
  }

  if (filters.productType) {
    query.productType = filters.productType;
  }

  if (filters.search) {
    const rawSearch = filters.search.trim();
    const cleanSearch = rawSearch.replace(/[^a-zA-Z0-9]/g, "");

    if (cleanSearch) {
      // Build regex pattern that allows optional non-alphanumeric characters between each character
      // e.g. "VB7" -> "V[^a-zA-Z0-9]*B[^a-zA-Z0-9]*7" to match "VB-7", "VB 7", "VB7"
      const flexiblePattern = cleanSearch.split("").join("[^a-zA-Z0-9]*");
      query.$or = [
        { name: { $regex: new RegExp(rawSearch, "i") } },
        { name: { $regex: new RegExp(flexiblePattern, "i") } },
      ];
    } else {
      query.name = { $regex: new RegExp(rawSearch, "i") };
    }
  }


  const page = Math.max(1, parseInt(options.page) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(options.limit) || 20));
  const skip = (page - 1) * limit;

  const sort = options.sort || { createdAt: -1 };

  const productQuery = WorkspaceProduct.find(query);
  if (options.summary) {
    productQuery
      .populate("manufacturer", "name")
      .populate("category", "name")
      .populate("productForm", "name");
  } else {
    productQuery
      .populate("HsnMaster", "code description gstRate cessRate isActive")
      .populate("manufacturer", "name description isActive")
      .populate("uom", "name abbreviation description isActive")
      .populate("category", "name slug parentCategory level description imageUrl isActive")
      .populate("productForm", "name description isActive")
      .populate("composition.salt", "name description isActive");
  }

  const [products, total] = await Promise.all([
    productQuery
      .sort(sort)
      .skip(skip)
      .limit(limit)
      .select(options.select || ""),
    WorkspaceProduct.countDocuments(query),
  ]);

  return { products, total, page, limit };
};

// ---------------------
// Write Operations
// ---------------------

const createWorkspaceProduct = async (payload) => {
  return WorkspaceProduct.create(payload);
};

const saveWorkspaceProduct = async (product) => {
  return product.save();
};

const softDeleteWorkspaceProductById = async (
  productId,
  workspaceId,
  userId = null,
) => {
  if (!mongoose.Types.ObjectId.isValid(productId)) {
    return null;
  }

  return WorkspaceProduct.findOneAndUpdate(
    {
      _id: productId,
      workspaceId,
      isDeleted: false,
    },
    {
      isDeleted: true,
      deletedAt: new Date(),
      deletedBy: userId,
      status: WORKSPACE_PRODUCT_STATUS.INACTIVE,
      updatedBy: userId,
    },
    {
      new: true,
      runValidators: true,
    },
  );
};

export default {
  findWorkspaceProductById,
  findWorkspaceProductByCode,
  findWorkspaceProductByName,
  getWorkspaceProducts,
  createWorkspaceProduct,
  saveWorkspaceProduct,
  softDeleteWorkspaceProductById,
};
