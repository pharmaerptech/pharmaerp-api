import mongoose from "mongoose";
import Doctor from "../models/doctor.model.js";

const findDoctorByIdAndCompany = async (
  doctorId,
  companyId,
  workspaceId,
  options = {}
) => {
  if (
    !mongoose.Types.ObjectId.isValid(doctorId) ||
    !mongoose.Types.ObjectId.isValid(companyId) ||
    !mongoose.Types.ObjectId.isValid(workspaceId)
  ) {
    return null;
  }

  return Doctor.findOne({
    _id: doctorId,
    companyId,
    workspaceId,
    isDeleted: false,
  })
    .populate("branchId", "name")
    .select(options.select || "");
};

const findDoctorByCode = async (doctorCode, options = {}) => {
  if (!doctorCode) return null;

  return Doctor.findOne({
    doctorCode: String(doctorCode).trim().toUpperCase(),
    isDeleted: false,
  })
    .populate("branchId", "name")
    .select(options.select || "");
};

const createDoctor = async (payload, options = {}) => {
  const [doctor] = await Doctor.create([payload], { session: options.session || null });
  return doctor;
};

const getDoctors = async (workspaceId, companyId, filters = {}, options = {}) => {
  if (!mongoose.Types.ObjectId.isValid(workspaceId)) {
    return {
      doctors: [],
      total: 0,
      page: 1,
      limit: 20,
      summary: {
        totalDoctors: 0,
        activeDoctors: 0,
        hospitalsCount: 0,
        specialtiesCount: 0,
      },
    };
  }

  const query = {
    workspaceId: new mongoose.Types.ObjectId(workspaceId),
    isDeleted: false,
  };

  if (companyId && mongoose.Types.ObjectId.isValid(companyId)) {
    query.companyId = new mongoose.Types.ObjectId(companyId);
  }

  if (filters.status && filters.status !== "all") {
    query.status = filters.status;
  }

  if (filters.specialty && filters.specialty !== "all") {
    query.specialty = { $regex: new RegExp(filters.specialty.trim(), "i") };
  }

  if (filters.search) {
    const searchRegex = new RegExp(filters.search.trim(), "i");
    query.$or = [
      { name: searchRegex },
      { hospitalName: searchRegex },
      { specialty: searchRegex },
      { registrationNumber: searchRegex },
      { doctorCode: searchRegex },
      { mobile: searchRegex },
    ];
  }

  const page = Math.max(1, parseInt(options.page) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(options.limit) || 20));
  const skip = (page - 1) * limit;

  let sort = { createdAt: -1 };
  if (options.sort) {
    if (options.sort === "name-asc") sort = { name: 1 };
    else if (options.sort === "name-desc") sort = { name: -1 };
    else if (options.sort === "createdAt-asc") sort = { createdAt: 1 };
    else if (options.sort === "createdAt-desc") sort = { createdAt: -1 };
    else if (typeof options.sort === "object") sort = options.sort;
  }

  const matchCriteria = {
    workspaceId: new mongoose.Types.ObjectId(workspaceId),
    isDeleted: false,
    ...(companyId && mongoose.Types.ObjectId.isValid(companyId)
      ? { companyId: new mongoose.Types.ObjectId(companyId) }
      : {}),
  };

  const [doctors, total, statsResult] = await Promise.all([
    Doctor.find(query)
      .populate("companyId", "name legalName code")
      .populate("branchId", "name")
      .sort(sort)
      .skip(skip)
      .limit(limit)
      .select(options.select || "")
      .lean(),
    Doctor.countDocuments(query),
    Doctor.aggregate([
      {
        $match: matchCriteria,
      },
      {
        $group: {
          _id: null,
          totalDoctors: { $sum: 1 },
          activeDoctors: {
            $sum: {
              $cond: [{ $eq: ["$status", "active"] }, 1, 0],
            },
          },
          hospitals: { $addToSet: "$hospitalName" },
          specialties: { $addToSet: "$specialty" },
        },
      },
      {
        $project: {
          _id: 0,
          totalDoctors: 1,
          activeDoctors: 1,
          hospitalsCount: {
            $size: {
              $filter: {
                input: "$hospitals",
                as: "h",
                cond: { $and: [{ $ne: ["$$h", null] }, { $ne: ["$$h", ""] }] },
              },
            },
          },
          specialtiesCount: {
            $size: {
              $filter: {
                input: "$specialties",
                as: "s",
                cond: { $and: [{ $ne: ["$$s", null] }, { $ne: ["$$s", ""] }] },
              },
            },
          },
        },
      },
    ]),
  ]);

  const summary = statsResult[0] || {
    totalDoctors: total,
    activeDoctors: 0,
    hospitalsCount: 0,
    specialtiesCount: 0,
  };

  return {
    doctors,
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit) || 1,
    summary,
  };
};

const updateDoctorById = async (doctorId, companyId, workspaceId, updateData) => {
  return Doctor.findOneAndUpdate(
    {
      _id: doctorId,
      companyId,
      workspaceId,
      isDeleted: false,
    },
    { $set: updateData },
    { new: true, runValidators: true }
  ).populate("branchId", "name");
};

const softDeleteDoctorById = async (doctorId, companyId, workspaceId, userId) => {
  return Doctor.findOneAndUpdate(
    {
      _id: doctorId,
      companyId,
      workspaceId,
      isDeleted: false,
    },
    {
      $set: {
        isDeleted: true,
        deletedAt: new Date(),
        deletedBy: userId,
      },
    },
    { new: true }
  );
};

export default {
  findDoctorByIdAndCompany,
  findDoctorByCode,
  createDoctor,
  getDoctors,
  updateDoctorById,
  softDeleteDoctorById,
};
