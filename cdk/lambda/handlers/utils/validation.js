/**
 * Input Validation Utilities
 * 
 * Lightweight validation helpers for Lambda handler input validation.
 * Prevents invalid data from reaching the database layer.
 */

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Validates that a value is a valid UUID v4 format.
 * @param {string} value - The value to validate
 * @param {string} fieldName - Name of the field (for error messages)
 * @returns {{ valid: boolean, error?: string }}
 */
function validateUUID(value, fieldName = "id") {
    if (!value || typeof value !== "string") {
        return { valid: false, error: `${fieldName} is required` };
    }
    if (!UUID_REGEX.test(value.trim())) {
        return { valid: false, error: `${fieldName} must be a valid UUID` };
    }
    return { valid: true };
}

/**
 * Validates that all required fields are present and non-empty in an object.
 * @param {Object} obj - The object to validate
 * @param {string[]} fields - Array of required field names
 * @returns {{ valid: boolean, error?: string }}
 */
function validateRequired(obj, fields) {
    if (!obj || typeof obj !== "object") {
        return { valid: false, error: "Request body is required" };
    }
    for (const field of fields) {
        if (obj[field] === undefined || obj[field] === null || obj[field] === "") {
            return { valid: false, error: `${field} is required` };
        }
    }
    return { valid: true };
}

/**
 * Validates that a value is one of the allowed enum values.
 * @param {string} value - The value to validate
 * @param {string[]} allowed - Array of allowed values
 * @param {string} fieldName - Name of the field (for error messages)
 * @returns {{ valid: boolean, error?: string }}
 */
function validateEnum(value, allowed, fieldName = "value") {
    if (!allowed.includes(value)) {
        return {
            valid: false,
            error: `Invalid ${fieldName}. Must be one of: ${allowed.join(", ")}`,
        };
    }
    return { valid: true };
}

/**
 * Sanitizes a string by trimming whitespace and capping length.
 * Returns null for empty/non-string values.
 * @param {*} value - The value to sanitize
 * @param {number} maxLength - Maximum allowed length (default 10000)
 * @returns {string|null}
 */
function sanitizeString(value, maxLength = 10000) {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    if (trimmed.length === 0) return null;
    return trimmed.slice(0, maxLength);
}

/**
 * Validates and parses a positive integer from a query parameter.
 * @param {string} value - The string value to parse
 * @param {number} defaultValue - Default if value is missing/invalid
 * @param {number} max - Maximum allowed value
 * @returns {number}
 */
function parsePositiveInt(value, defaultValue, max = 1000) {
    const parsed = parseInt(value);
    if (isNaN(parsed) || parsed < 0) return defaultValue;
    return Math.min(parsed, max);
}

module.exports = {
    validateUUID,
    validateRequired,
    validateEnum,
    sanitizeString,
    parsePositiveInt,
};
