import { useState, useEffect } from "react";
import JSZip from "jszip";
import {
  Search,
  Upload,
  RefreshCw,
  FileText,
  Users,
  HelpCircle,
  Loader2,
  AlertTriangle,
  MessageCircleMore,
  Play,
  Archive,
} from "lucide-react";
import { AuthService } from "@/functions/authService";
import { getCurrentUser } from "aws-amplify/auth";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import MetricCard from "./MetricCard.tsx";

type AnalyticsTotals = {
  users: number;
  chat_sessions: number;
  messages: number;
  questions?: number;
};

type DataSourceType = "csv" | "markdown" | "json" | "website";

type DataSourceRow = {
  id: string;
  name: string;
  type: DataSourceType;
  created_at: string;
  metadata: Record<string, unknown>;
  include_patterns?: string[];
  exclude_patterns?: string[];
};

type IngestionRunStatus =
  | "pending"
  | "queued"
  | "running"
  | "failed"
  | "completed";

type IngestionRunRow = {
  id: string;
  data_source_id: string;
  status: IngestionRunStatus;
  error_message?: string | null;
  created_at: string;
  completed_at?: string | null;
};

type AdminDataSourcesResponse = {
  items: Array<{
    data_source: DataSourceRow;
    latest_ingestion_run: IngestionRunRow | null;
  }>;
};

type PresignedUploadResponse = {
  presignedUrl: string;
  bucket: string;
  key: string;
};

type BatchPresignedUrlEntry = {
  file_name: string;
  presigned_url: string;
  key: string;
  bucket: string;
};

type ZipFilePair = {
  primaryFile: File;
  metadataFile: File;
  type: "csv" | "markdown";
  error?: string;
};

function formatDateTime(iso?: string | null) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

function typeLabel(t: DataSourceType) {
  if (t === "website") return "Website";
  if (t === "csv") return "CSV";
  if (t === "markdown") return "Markdown";
  if (t === "json") return "JSON";
  return t;
}

// hasErrors: the run completed but the ingestion job reported failure reasons
function statusBadge(status: IngestionRunStatus | "no_runs", hasErrors = false) {
  switch (status) {
    case "pending":
      return <Badge className="bg-gray-100 text-gray-700">Pending</Badge>;
    case "queued":
      return <Badge className="bg-amber-100 text-amber-700">Queued</Badge>;
    case "completed":
      if (hasErrors) {
        return <Badge className="bg-orange-100 text-orange-700">Completed with errors</Badge>;
      }
      return <Badge className="bg-green-100 text-green-700">Completed</Badge>;
    case "failed":
      return <Badge className="bg-red-100 text-red-700">Failed</Badge>;
    case "running":
      return <Badge className="bg-blue-100 text-blue-700">Running</Badge>;
    default:
      return <Badge className="bg-gray-100 text-gray-700">No runs</Badge>;
  }
}

function parsePatterns(text: string): string[] {
  return text
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function formatSizeMb(file: File | null) {
  if (!file) return "";
  return `${(file.size / (1024 * 1024)).toFixed(2)} MB`;
}

function isMarkdownFile(file: File) {
  const lower = file.name.toLowerCase();
  return lower.endsWith(".md") || lower.endsWith(".markdown") || file.type === "text/markdown";
}

function isCsvFile(file: File) {
  return file.name.toLowerCase().endsWith(".csv") || file.type === "text/csv";
}

function validatePrimaryFile(file: File): string | null {
  const valid = isCsvFile(file) || isMarkdownFile(file);

  if (!valid) return "Only CSV or Markdown files are allowed.";
  if (file.size > 50 * 1024 * 1024) return "File size must be less than 50MB.";
  return null;
}

function getPrimaryFileType(file: File): "csv" | "markdown" {
  return isMarkdownFile(file) ? "markdown" : "csv";
}

function validateMetadataFile(file: File): string | null {
  const lower = file.name.toLowerCase();
  const isJson =
    lower.endsWith(".json") ||
    file.type === "application/json" ||
    file.type === "text/json";

  if (!isJson) return "Only JSON metadata files are allowed.";
  if (file.size > 50 * 1024 * 1024) return "Metadata JSON file size must be less than 50MB.";
  return null;
}

function expectedMetadataFileName(primaryFileName: string) {
  return `${primaryFileName}.metadata.json`;
}

export default function DataSourceManagement() {
  const [adminEmail, setAdminEmail] = useState<string | null>(null);

  const [isUrlDialogOpen, setIsUrlDialogOpen] = useState(false);
  const [webUrl, setWebUrl] = useState("");
  const [webUrlStatus, setWebUrlStatus] = useState<{
    type: "success" | "error" | null;
    message: string;
  }>({ type: null, message: "" });
  const [addingUrl, setAddingUrl] = useState(false);

  const [searchQuery, setSearchQuery] = useState("");
  const [isUploadOpen, setIsUploadOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [primaryFile, setPrimaryFile] = useState<File | null>(null);
  const [metadataFile, setMetadataFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadStatus, setUploadStatus] = useState<{
    type: "success" | "error" | null;
    message: string;
  }>({ type: null, message: "" });

  // Upload tab: "single" | "zip"
  const [uploadTab, setUploadTab] = useState<"single" | "zip">("single");

  // Zip upload state
  const [zipFile, setZipFile] = useState<File | null>(null);
  const [zipPairs, setZipPairs] = useState<ZipFilePair[]>([]);
  const [zipValidating, setZipValidating] = useState(false);
  const [zipUploading, setZipUploading] = useState(false);
  const [zipStatus, setZipStatus] = useState<{
    type: "success" | "error" | null;
    message: string;
  }>({ type: null, message: "" });

  const [syncStatus, setSyncStatus] = useState<{
    type: "success" | "error" | null;
    message: string;
  }>({ type: null, message: "" });

  const [totals, setTotals] = useState<AnalyticsTotals>({
    users: 0,
    chat_sessions: 0,
    messages: 0,
    questions: 0,
  });

  const [dataSources, setDataSources] = useState<DataSourceRow[]>([]);
  const [ingestionRuns, setIngestionRuns] = useState<IngestionRunRow[]>([]);

  // shows subrow
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [includePatternsText, setIncludePatternsText] = useState("");
  const [excludePatternsText, setExcludePatternsText] = useState("");

  const PAGE_SIZE = 5;
  const [page, setPage] = useState(1);

  const fetchAdminCredentials = async () => {
    const user = await getCurrentUser();
    const email = user?.signInDetails?.loginId ?? null;
    setAdminEmail(email);
  };

  const fetchAnalyticsTotals = async () => {
    try {
      setLoading(true);
      setError(null);

      const session = await AuthService.getAuthSession(true);
      const token = session.tokens.idToken;

      // no timeRange so backend returns ALL-TIME totals
      const res = await fetch(`${import.meta.env.VITE_API_ENDPOINT}/admin/analytics`, {
        headers: {
          Authorization: token,
          "Content-Type": "application/json",
        },
      });

      if (!res.ok) throw new Error("Failed to fetch analytics");

      const data = (await res.json()) as { totals: AnalyticsTotals };

      setTotals({
        users: data.totals?.users ?? 0,
        chat_sessions: data.totals?.chat_sessions ?? 0,
        messages: data.totals?.messages ?? 0,
        questions: data.totals?.questions ?? 0,
      });
    } catch (e) {
      console.error(e);
      setError("Failed to load analytics");
    } finally {
      setLoading(false);
    }
  };

  const fetchAdminDataSources = async () => {
    try {
      setLoading(true);
      setError(null);

      const session = await AuthService.getAuthSession(true);
      const token = session.tokens.idToken;

      const res = await fetch(
        `${import.meta.env.VITE_API_ENDPOINT}/admin/data_sources`,
        {
          headers: {
            Authorization: token,
            "Content-Type": "application/json",
          },
        }
      );

      if (!res.ok) throw new Error("Failed to fetch data sources");

      const data = (await res.json()) as AdminDataSourcesResponse;

      const ds = data.items.map((x) => x.data_source);
      const runs = data.items
        .map((x) => x.latest_ingestion_run)
        .filter((r): r is IngestionRunRow => !!r);

      setDataSources(ds);
      setIngestionRuns(runs);
    } catch (e) {
      console.error(e);
      setError("Failed to load data sources");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchAdminCredentials();
    fetchAnalyticsTotals();
    fetchAdminDataSources();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    setPage(1);
  }, [searchQuery]);

  useEffect(() => {
    setPage(1);
  }, [dataSources.length]);

  const handleStartSync = async () => {
    if (!adminEmail) {
      setSyncStatus({
        type: "error",
        message: "Unable to determine the current admin email.",
      });
      return;
    }

    try {
      setSyncing(true);
      setSyncStatus({ type: null, message: "" });

      const session = await AuthService.getAuthSession(true);
      const token = session.tokens.idToken;

      const res = await fetch(
        `${import.meta.env.VITE_API_ENDPOINT}/admin/data_sources/sync`,
        {
          method: "POST",
          headers: {
            Authorization: token,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            created_by: adminEmail,
          }),
        }
      );

      const responseJson = await res.json().catch(() => ({}));

      if (!res.ok) {
        throw new Error(
          responseJson?.error ||
            responseJson?.message ||
            "Failed to start sync."
        );
      }

      setSyncStatus({
        type: "success",
        message:
          responseJson?.message ||
          "Sync started successfully.",
      });

      await fetchAdminDataSources();
    } catch (e) {
      console.error(e);
      setSyncStatus({
        type: "error",
        message: e instanceof Error ? e.message : "Failed to start sync",
      });
    } finally {
      setSyncing(false);
    }
  };

  const handleAddWebUrl = async () => {
    setAddingUrl(true);
    try {
      setWebUrlStatus({ type: null, message: "" });

      if (!webUrl || !/^https?:\/\//.test(webUrl.trim())) {
        setWebUrlStatus({
          type: "error",
          message: "Please enter a valid URL (must start with http:// or https://).",
        });
        return;
      }

      if (!adminEmail) {
        setWebUrlStatus({
          type: "error",
          message: "Unable to determine the current admin email.",
        });
        return;
      }

      const include_patterns = parsePatterns(includePatternsText);
      const exclude_patterns = parsePatterns(excludePatternsText);

      const session = await AuthService.getAuthSession(true);
      const token = session.tokens.idToken;

      const res = await fetch(
        `${import.meta.env.VITE_API_ENDPOINT}/admin/data_sources`,
        {
          method: "POST",
          headers: {
            Authorization: token,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            type: "website",
            name: webUrl.trim(),
            include_patterns,
            exclude_patterns,
            created_by: adminEmail,
          }),
        }
      );

      const responseJson = await res.json().catch(() => ({}));

      if (!res.ok) {
        throw new Error(responseJson?.error || responseJson?.message || "Failed to stage URL");
      }

      setWebUrlStatus({
        type: "success",
        message: responseJson?.message || "URL staged successfully.",
      });

      await fetchAdminDataSources();

      setTimeout(() => {
        setIsUrlDialogOpen(false);
        setWebUrl("");
        setIncludePatternsText("");
        setExcludePatternsText("");
        setWebUrlStatus({ type: null, message: "" });
      }, 800);
    } catch (e) {
      console.error(e);
      setWebUrlStatus({
        type: "error",
        message: e instanceof Error ? e.message : "Failed to stage URL",
      });
    } finally {
      setAddingUrl(false);
    }
  };

  const handlePrimaryFileSelect = (selectedFile: File) => {
    setUploadStatus({ type: null, message: "" });
    const validationError = validatePrimaryFile(selectedFile);
    if (validationError) {
      setUploadStatus({ type: "error", message: validationError });
      return;
    }
    setPrimaryFile(selectedFile);
  };

  const handleMetadataFileSelect = (selectedFile: File) => {
    setUploadStatus({ type: null, message: "" });
    const validationError = validateMetadataFile(selectedFile);
    if (validationError) {
      setUploadStatus({ type: "error", message: validationError });
      return;
    }
    setMetadataFile(selectedFile);
  };

  const getPresignedUpload = async (
    token: string,
    file: File,
    uploadType: "csv" | "markdown" | "json"
  ): Promise<PresignedUploadResponse> => {
    const fallbackContentType =
      uploadType === "csv"
        ? "text/csv"
        : uploadType === "markdown"
        ? "text/markdown"
        : "application/json";

    const res = await fetch(
      `${import.meta.env.VITE_API_ENDPOINT}/admin/generate-presigned-url?file_name=${encodeURIComponent(
        file.name
      )}&content_type=${encodeURIComponent(file.type || fallbackContentType)}`,
      {
        headers: {
          Authorization: token,
        },
      }
    );

    if (!res.ok) {
      throw new Error(`Failed to generate upload URL for ${file.name}`);
    }

    return (await res.json()) as PresignedUploadResponse;
  };

  const uploadFileToS3 = async (
    presignedUrl: string,
    file: File,
    fallbackContentType: string
  ) => {
    const uploadResponse = await fetch(presignedUrl, {
      method: "PUT",
      headers: {
        "Content-Type": file.type || fallbackContentType,
      },
      body: file,
    });

    if (!uploadResponse.ok) {
      throw new Error(`Failed to upload ${file.name} to S3`);
    }
  };

  const resetUploadDialog = () => {
    setIsUploadOpen(false);
    setPrimaryFile(null);
    setMetadataFile(null);
    setUploadStatus({ type: null, message: "" });
    setUploadTab("single");
    setZipFile(null);
    setZipPairs([]);
    setZipStatus({ type: null, message: "" });
  };

  const handleZipSelect = async (file: File) => {
    setZipStatus({ type: null, message: "" });
    setZipPairs([]);

    if (!file.name.toLowerCase().endsWith(".zip")) {
      setZipStatus({ type: "error", message: "Only .zip files are allowed." });
      return;
    }
    if (file.size > 200 * 1024 * 1024) {
      setZipStatus({ type: "error", message: "Zip file must be less than 200MB." });
      return;
    }

    setZipFile(file);
    setZipValidating(true);

    try {
      const zip = await JSZip.loadAsync(file);
      const allNames = Object.keys(zip.files).filter((n) => !zip.files[n].dir);

      // Build a map of name -> JSZip file entry (basename only, ignore subdirs)
      const fileMap = new Map<string, JSZip.JSZipObject>();
      for (const name of allNames) {
        const base = name.split("/").pop()!;
        fileMap.set(base, zip.files[name]);
      }

      const pairs: ZipFilePair[] = [];
      const seen = new Set<string>();

      for (const [baseName, entry] of fileMap) {
        // Skip metadata files — they'll be matched from the primary side
        if (baseName.endsWith(".metadata.json")) continue;

        const isCsv = baseName.toLowerCase().endsWith(".csv");
        const isMd = baseName.toLowerCase().endsWith(".md") || baseName.toLowerCase().endsWith(".markdown");
        if (!isCsv && !isMd) continue;
        if (seen.has(baseName)) continue;
        seen.add(baseName);

        const expectedMeta = `${baseName}.metadata.json`;
        const metaEntry = fileMap.get(expectedMeta);

        const primaryBlob = await entry.async("blob");
        const primaryFileObj = new File(
          [primaryBlob],
          baseName,
          { type: isCsv ? "text/csv" : "text/markdown" }
        );

        if (!metaEntry) {
          pairs.push({
            primaryFile: primaryFileObj,
            metadataFile: null as unknown as File,
            type: isCsv ? "csv" : "markdown",
            error: `Missing metadata file: ${expectedMeta}`,
          });
          continue;
        }

        const metaBlob = await metaEntry.async("blob");
        const metaFileObj = new File([metaBlob], expectedMeta, { type: "application/json" });

        pairs.push({
          primaryFile: primaryFileObj,
          metadataFile: metaFileObj,
          type: isCsv ? "csv" : "markdown",
        });
      }

      if (pairs.length === 0) {
        setZipStatus({ type: "error", message: "No valid CSV or Markdown files found in the zip." });
        setZipFile(null);
      } else {
        setZipPairs(pairs);
      }
    } catch (e) {
      console.error(e);
      setZipStatus({ type: "error", message: "Failed to read zip file. Make sure it's a valid zip." });
      setZipFile(null);
    } finally {
      setZipValidating(false);
    }
  };

  const handleZipUpload = async () => {
    const validPairs = zipPairs.filter((p) => !p.error);
    if (validPairs.length === 0) {
      setZipStatus({ type: "error", message: "No valid file pairs to upload." });
      return;
    }
    if (!adminEmail) {
      setZipStatus({ type: "error", message: "Unable to determine the current admin email." });
      return;
    }

    try {
      setZipUploading(true);
      setZipStatus({ type: null, message: "" });

      const session = await AuthService.getAuthSession(true);
      const token = session.tokens.idToken;

      // Step 1: Get all presigned URLs in one request
      const filesPayload = validPairs.flatMap((p) => [
        {
          file_name: p.primaryFile.name,
          content_type: p.type === "csv" ? "text/csv" : "text/markdown",
        },
        {
          file_name: p.metadataFile.name,
          content_type: "application/json",
        },
      ]);

      const batchUrlRes = await fetch(
        `${import.meta.env.VITE_API_ENDPOINT}/admin/generate-presigned-urls/batch`,
        {
          method: "POST",
          headers: { Authorization: token, "Content-Type": "application/json" },
          body: JSON.stringify({ files: filesPayload }),
        }
      );

      if (!batchUrlRes.ok) {
        const err = await batchUrlRes.json().catch(() => ({}));
        throw new Error(err?.error || "Failed to generate presigned URLs");
      }

      const { presigned_urls } = (await batchUrlRes.json()) as {
        presigned_urls: BatchPresignedUrlEntry[];
      };

      // Build a lookup map by file_name
      const urlMap = new Map<string, BatchPresignedUrlEntry>();
      for (const entry of presigned_urls) {
        urlMap.set(entry.file_name, entry);
      }

      // Step 2: Upload all files to S3 in parallel
      await Promise.all(
        validPairs.flatMap((p) => {
          const primaryEntry = urlMap.get(p.primaryFile.name)!;
          const metaEntry = urlMap.get(p.metadataFile.name)!;
          return [
            fetch(primaryEntry.presigned_url, {
              method: "PUT",
              headers: { "Content-Type": p.type === "csv" ? "text/csv" : "text/markdown" },
              body: p.primaryFile,
            }),
            fetch(metaEntry.presigned_url, {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              body: p.metadataFile,
            }),
          ];
        })
      );

      // Step 3: Stage all pairs in one batch request
      const stageItems = validPairs.map((p) => {
        const primaryEntry = urlMap.get(p.primaryFile.name)!;
        const metaEntry = urlMap.get(p.metadataFile.name)!;
        return {
          type: p.type,
          primary_file_name: p.primaryFile.name,
          primary_s3_bucket: primaryEntry.bucket,
          primary_s3_key: primaryEntry.key,
          metadata_file_name: p.metadataFile.name,
          metadata_s3_bucket: metaEntry.bucket,
          metadata_s3_key: metaEntry.key,
        };
      });

      const stageRes = await fetch(
        `${import.meta.env.VITE_API_ENDPOINT}/admin/data_sources/batch`,
        {
          method: "POST",
          headers: { Authorization: token, "Content-Type": "application/json" },
          body: JSON.stringify({ created_by: adminEmail, items: stageItems }),
        }
      );

      const stageJson = await stageRes.json().catch(() => ({}));
      if (!stageRes.ok) {
        throw new Error(stageJson?.error || "Batch staging failed");
      }

      const { staged_count, skipped_count, error_count } = stageJson;
      setZipStatus({
        type: error_count > 0 && staged_count === 0 ? "error" : "success",
        message: `Done. ${staged_count} staged, ${skipped_count} skipped (duplicates), ${error_count} failed.`,
      });

      await fetchAdminDataSources();

      if (error_count === 0) {
        setTimeout(() => resetUploadDialog(), 1500);
      }
    } catch (e) {
      console.error(e);
      setZipStatus({
        type: "error",
        message: e instanceof Error ? e.message : "Zip upload failed",
      });
    } finally {
      setZipUploading(false);
    }
  };

  const handleUpload = async () => {
    if (!primaryFile || !metadataFile) {
      setUploadStatus({
        type: "error",
        message: "Please select both the primary file and the metadata JSON file.",
      });
      return;
    }

    if (!adminEmail) {
      setUploadStatus({
        type: "error",
        message: "Unable to determine the current admin email.",
      });
      return;
    }

    const expectedMetadata = expectedMetadataFileName(primaryFile.name);
    if (metadataFile.name !== expectedMetadata) {
      setUploadStatus({
        type: "error",
        message: `Metadata file name must be exactly ${expectedMetadata}`,
      });
      return;
    }

    try {
      setUploading(true);
      setUploadStatus({ type: null, message: "" });

      const session = await AuthService.getAuthSession(true);
      const token = session.tokens.idToken;

      const primaryType = getPrimaryFileType(primaryFile);

      const primaryUpload = await getPresignedUpload(token, primaryFile, primaryType);
      await uploadFileToS3(
        primaryUpload.presignedUrl,
        primaryFile,
        primaryType === "csv" ? "text/csv" : "text/markdown"
      );

      const metadataUpload = await getPresignedUpload(token, metadataFile, "json");
      await uploadFileToS3(metadataUpload.presignedUrl, metadataFile, "application/json");

      const body =
        primaryType === "csv"
          ? {
              type: "csv",
              csv_file_name: primaryFile.name,
              csv_s3_bucket: primaryUpload.bucket,
              csv_s3_key: primaryUpload.key,
              metadata_file_name: metadataFile.name,
              metadata_s3_bucket: metadataUpload.bucket,
              metadata_s3_key: metadataUpload.key,
              created_by: adminEmail,
            }
          : {
              type: "markdown",
              markdown_file_name: primaryFile.name,
              markdown_s3_bucket: primaryUpload.bucket,
              markdown_s3_key: primaryUpload.key,
              metadata_file_name: metadataFile.name,
              metadata_s3_bucket: metadataUpload.bucket,
              metadata_s3_key: metadataUpload.key,
              created_by: adminEmail,
            };

      const stageResponse = await fetch(
        `${import.meta.env.VITE_API_ENDPOINT}/admin/data_sources`,
        {
          method: "POST",
          headers: {
            Authorization: token,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
        }
      );

      const responseJson = await stageResponse.json().catch(() => ({}));

      if (!stageResponse.ok) {
        throw new Error(
          responseJson?.error ||
            responseJson?.message ||
            "Upload succeeded but staging could not be completed."
        );
      }

      setUploadStatus({
        type: "success",
        message:
          responseJson?.message ||
          `${primaryType === "csv" ? "CSV" : "Markdown"} and metadata uploaded and staged successfully.`,
      });

      await fetchAdminDataSources();

      setTimeout(() => {
        resetUploadDialog();
      }, 1200);
    } catch (err) {
      console.error("Upload error:", err);
      setUploadStatus({
        type: "error",
        message: err instanceof Error ? err.message : "Upload failed",
      });
    } finally {
      setUploading(false);
    }
  };

  const latestRunBySourceId = (() => {
    const map = new Map<string, IngestionRunRow>();
    for (const r of ingestionRuns) {
      const existing = map.get(r.data_source_id);
      const a = existing?.created_at ? new Date(existing.created_at).getTime() : 0;
      const b = r.created_at ? new Date(r.created_at).getTime() : 0;
      if (!existing || b > a) map.set(r.data_source_id, r);
    }
    return map;
  })();

  // For CSV -> JSON pairing: "alumni_data_final.csv" -> find "alumni_data_final.csv.metadata.json"
  // For markdown -> JSON pairing: "alumni_data_final.md" -> find "alumni_data_final.md.metadata.json"
  const jsonByCsvName = (() => {
    const map = new Map<string, DataSourceRow>();
    for (const ds of dataSources) {
      if (ds.type === "json" && ds.name.endsWith(".metadata.json")) {
        const base = ds.name.replace(".metadata.json", "");
        map.set(base, ds);
      }
    }
    return map;
  })();

  // hide JSON rows from main table (they appear as subrow under CSV/markdown)
  const filteredDataSources = dataSources
    .filter((ds) => ds.type !== "json")
    .filter((ds) => {
      if (!searchQuery.trim()) return true;
      const q = searchQuery.trim().toLowerCase();
      return (
        ds.name.toLowerCase().includes(q) || ds.type.toLowerCase().includes(q)
      );
    });

  const hasPendingLikeItems = ingestionRuns.some(
    (r) => r.status === "pending" || r.status === "queued"
  );

  const totalPages = Math.max(1, Math.ceil(filteredDataSources.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const startIdx = (currentPage - 1) * PAGE_SIZE;
  const pagedDataSources = filteredDataSources.slice(startIdx, startIdx + PAGE_SIZE);

  return (
    <div className="space-y-8 max-w-7xl mx-auto animate-in fade-in duration-500">
      <div>
        <h2 className="text-3xl font-bold text-gray-900">Admin Dashboard</h2>
        <p className="text-gray-500 mt-1">
          Manage your data sources and platform overview.
        </p>
      </div>

      {/* Error Message */}
      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg">
          <p className="font-medium">Error loading data</p>
          <p className="text-sm">{error}</p>
        </div>
      )}

      {/* Metrics Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <MetricCard
          title="Total Users"
          value={loading ? "..." : totals.users.toLocaleString()}
          icon={<Users className="h-5 w-5 text-primary" />}
          trend="Unique users"
          tooltip="Calculated by counting distinct users with chat sessions."
        />

        <MetricCard
          title="Total Chat sessions"
          value={loading ? "..." : totals.chat_sessions.toLocaleString()}
          icon={<MessageCircleMore className="h-5 w-5 text-primary" />}
          trend="Total Chat sessions"
          tooltip="Total chat sessions across all users."
        />

        <MetricCard
          title="Total Messages"
          value={loading ? "..." : totals.messages.toLocaleString()}
          icon={<HelpCircle className="h-5 w-5 text-[#3d7a9a]" />}
          trend="Total Messages Exchanged"
          tooltip="Total chat messages exchanged across all sessions."
        />
      </div>

      {/* Data Source Management Section */}
      <div className="space-y-4">
        <div className="flex flex-col gap-3">
          <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
            <h3 className="text-xl font-semibold text-gray-900">
              Data Sources
            </h3>
            <div className="flex flex-wrap gap-2">
              <Button
                className="bg-primary text-white"
                onClick={handleStartSync}
                disabled={syncing || !hasPendingLikeItems}
              >
                {syncing ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Syncing...
                  </>
                ) : (
                  <>
                    <Play className="mr-2 h-4 w-4" />
                    Sync
                  </>
                )}
              </Button>

              <Dialog open={isUrlDialogOpen} onOpenChange={setIsUrlDialogOpen}>
                <DialogTrigger asChild>
                  <Button variant="outline" className="bg-primary text-white">
                    Add Web URL
                  </Button>
                </DialogTrigger>
                <DialogContent className="sm:max-w-md">
                  <DialogHeader>
                    <DialogTitle>Add Web URL</DialogTitle>
                    <DialogDescription>
                      Stage a website URL for the next sync.
                    </DialogDescription>
                  </DialogHeader>
                  <div className="grid gap-4 py-4">
                    <div className="space-y-2">
                      <div className="text-sm font-medium text-gray-900">Web URL</div>
                      <Input
                        type="url"
                        placeholder="https://example.com/resource"
                        value={webUrl}
                        onChange={(e) => {
                          setWebUrl(e.target.value);
                          setWebUrlStatus({ type: null, message: "" });
                        }}
                      />
                    </div>

                    <div className="space-y-2">
                      <div className="text-sm font-medium text-gray-900">Include patterns</div>
                      <div className="text-xs text-gray-500">
                        Optional. One regex per line.
                      </div>
                      <textarea
                        value={includePatternsText}
                        onChange={(e) => setIncludePatternsText(e.target.value)}
                        placeholder="^https:\/\/example\.com\/science\/.*"
                        className="min-h-[96px] w-full rounded-md border border-gray-200 bg-white px-3 py-2 text-sm font-mono"
                      />
                    </div>

                    <div className="space-y-2">
                      <div className="text-sm font-medium text-gray-900">Exclude patterns</div>
                      <div className="text-xs text-gray-500">
                        Optional. One regex per line.
                      </div>
                      <textarea
                        value={excludePatternsText}
                        onChange={(e) => setExcludePatternsText(e.target.value)}
                        placeholder="^https:\/\/example\.com\/science\/private\/.*"
                        className="min-h-[96px] w-full rounded-md border border-gray-200 bg-white px-3 py-2 text-sm font-mono"
                      />
                    </div>

                    {webUrlStatus.message && (
                      <div
                        className={`text-sm p-2 rounded ${
                          webUrlStatus.type === "success"
                            ? "bg-green-100 text-green-700"
                            : "bg-red-100 text-red-700"
                        }`}
                      >
                        {webUrlStatus.message}
                      </div>
                    )}
                  </div>
                  <DialogFooter>
                    <Button
                      variant="outline"
                      onClick={() => {
                        setIsUrlDialogOpen(false);
                        setWebUrl("");
                        setIncludePatternsText("");
                        setExcludePatternsText("");
                        setWebUrlStatus({ type: null, message: "" });
                      }}
                    >
                      Cancel
                    </Button>
                    <Button onClick={handleAddWebUrl} disabled={!webUrl || addingUrl}>
                      {addingUrl ? (
                        <>
                          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                          Adding...
                        </>
                      ) : (
                        "Stage URL"
                      )}
                    </Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>

              <Dialog open={isUploadOpen} onOpenChange={setIsUploadOpen}>
                <DialogTrigger asChild>
                  <Button variant="outline" className="bg-primary text-white">
                    <Upload className="mr-2 h-4 w-4" />
                    Add Data (CSV or Markdown)
                  </Button>
                </DialogTrigger>
                <DialogContent className="sm:max-w-2xl">
                  <DialogHeader>
                    <DialogTitle>Upload Data</DialogTitle>
                    <DialogDescription>
                      Upload files to stage for the next sync.
                    </DialogDescription>
                  </DialogHeader>

                  {/* Tab switcher */}
                  <div className="flex gap-1 border-b border-gray-200 mb-2">
                    <button
                      type="button"
                      onClick={() => setUploadTab("single")}
                      className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                        uploadTab === "single"
                          ? "border-primary text-primary"
                          : "border-transparent text-gray-500 hover:text-gray-700"
                      }`}
                    >
                      <Upload className="inline h-3.5 w-3.5 mr-1.5" />
                      Single File
                    </button>
                    <button
                      type="button"
                      onClick={() => setUploadTab("zip")}
                      className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                        uploadTab === "zip"
                          ? "border-primary text-primary"
                          : "border-transparent text-gray-500 hover:text-gray-700"
                      }`}
                    >
                      <Archive className="inline h-3.5 w-3.5 mr-1.5" />
                      Zip Upload
                    </button>
                  </div>

                  {/* Single file tab */}
                  {uploadTab === "single" && (
                  <div className="grid gap-4 py-4">
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <div className="space-y-2">
                        <div className="text-sm font-medium text-gray-900">CSV or Markdown file</div>

                        {!primaryFile ? (
                          <div
                            className="border-2 border-dashed border-gray-300 rounded-lg p-6 text-center hover:bg-gray-50 transition-colors cursor-pointer"
                            onDragOver={(e) => e.preventDefault()}
                            onDrop={(e) => {
                              e.preventDefault();
                              const droppedFile = e.dataTransfer.files?.[0];
                              if (droppedFile) handlePrimaryFileSelect(droppedFile);
                            }}
                            onClick={() => document.getElementById("csv-upload")?.click()}
                          >
                            <div className="flex flex-col items-center gap-2">
                              <Upload className="h-8 w-8 text-gray-400" />
                              <span className="text-sm font-medium text-gray-600">
                                Drag and drop CSV or Markdown
                              </span>
                              <span className="text-xs text-gray-400">
                                or click to browse
                              </span>
                            </div>
                            <Input
                              id="csv-upload"
                              type="file"
                              className="hidden"
                              accept=".csv,text/csv,.md,.markdown,text/markdown"
                              onChange={(e) => {
                                const selectedFile = e.target.files?.[0];
                                if (selectedFile) handlePrimaryFileSelect(selectedFile);
                              }}
                            />
                          </div>
                        ) : (
                          <div className="border rounded-lg p-4 bg-gray-50">
                            <div className="flex items-center justify-between mb-2">
                              <div className="flex items-center gap-2 overflow-hidden">
                                <FileText className="h-5 w-5 text-primary flex-shrink-0" />
                                <span className="text-sm font-medium truncate">{primaryFile.name}</span>
                              </div>
                            </div>
                            <div className="text-xs text-gray-500">{formatSizeMb(primaryFile)}</div>
                          </div>
                        )}
                      </div>

                      <div className="space-y-2">
                        <div className="text-sm font-medium text-gray-900">Metadata JSON file</div>

                        {!metadataFile ? (
                          <div
                            className="border-2 border-dashed border-gray-300 rounded-lg p-6 text-center hover:bg-gray-50 transition-colors cursor-pointer"
                            onDragOver={(e) => e.preventDefault()}
                            onDrop={(e) => {
                              e.preventDefault();
                              const droppedFile = e.dataTransfer.files?.[0];
                              if (droppedFile) handleMetadataFileSelect(droppedFile);
                            }}
                            onClick={() => document.getElementById("metadata-upload")?.click()}
                          >
                            <div className="flex flex-col items-center gap-2">
                              <Upload className="h-8 w-8 text-gray-400" />
                              <span className="text-sm font-medium text-gray-600">
                                Drag and drop metadata JSON
                              </span>
                              <span className="text-xs text-gray-400">
                                or click to browse
                              </span>
                            </div>
                            <Input
                              id="metadata-upload"
                              type="file"
                              className="hidden"
                              accept=".json,application/json,text/json"
                              onChange={(e) => {
                                const selectedFile = e.target.files?.[0];
                                if (selectedFile) handleMetadataFileSelect(selectedFile);
                              }}
                            />
                          </div>
                        ) : (
                          <div className="border rounded-lg p-4 bg-gray-50">
                            <div className="flex items-center justify-between mb-2">
                              <div className="flex items-center gap-2 overflow-hidden">
                                <FileText className="h-5 w-5 text-primary flex-shrink-0" />
                                <span className="text-sm font-medium truncate">{metadataFile.name}</span>
                              </div>
                            </div>
                            <div className="text-xs text-gray-500">{formatSizeMb(metadataFile)}</div>
                          </div>
                        )}
                      </div>
                    </div>

                    {primaryFile && (
                      <div className="text-xs text-gray-600">
                        Expected metadata filename:{" "}
                        <code className="bg-gray-100 px-1 py-0.5 rounded">
                          {expectedMetadataFileName(primaryFile.name)}
                        </code>
                      </div>
                    )}

                    {uploadStatus.message && (
                      <div
                        className={`text-sm p-2 rounded ${
                          uploadStatus.type === "success"
                            ? "bg-green-100 text-green-700"
                            : "bg-red-100 text-red-700"
                        }`}
                      >
                        {uploadStatus.message}
                      </div>
                    )}

                    <div className="space-y-3 text-xs">
                      <div className="rounded-lg border border-amber-200 bg-amber-50 p-3">
                        <div className="flex items-start gap-2">
                          <AlertTriangle className="h-4 w-4 text-amber-700 mt-0.5" />
                          <div className="text-amber-800">
                            <div className="font-semibold">Two files are required</div>
                            <div className="mt-1 text-amber-700">
                              1) The <span className="font-medium">CSV</span> or <span className="font-medium">Markdown</span> file
                              <br />
                              2) A matching <span className="font-medium">metadata JSON</span> file
                              with the exact name{" "}
                              <code className="bg-white/70 px-1 py-0.5 rounded border border-amber-200">
                                {"<csv/md-file-name>.metadata.json"}
                              </code>
                            </div>
                          </div>
                        </div>
                      </div>

                      <div className="text-gray-500">
                        <p className="font-medium mb-1 text-gray-700">Required CSV Columns for Alumni Data:</p>
                        <code className="bg-gray-100 px-1 py-0.5 rounded">
                          Profile, Headline, Year, Degree
                        </code>
                      </div>

                      <div className="text-gray-500">
                        <p className="font-medium mb-1 text-gray-700">Metadata JSON for Alumni Data should include:</p>
                        <code className="bg-gray-100 px-1 py-0.5 rounded">
                          size_bytes, storage_class, schema_version, columns, source
                        </code>
                      </div>
                    </div>
                  </div>
                  )}

                  {/* Zip upload tab */}
                  {uploadTab === "zip" && (
                  <div className="grid gap-4 py-4">
                    <div className="text-sm text-gray-600">
                      Upload a zip containing CSV/Markdown files and their matching{" "}
                      <code className="bg-gray-100 px-1 rounded">*.metadata.json</code> files.
                      Duplicates are skipped automatically.
                    </div>

                    {!zipFile ? (
                      <div
                        className="border-2 border-dashed border-gray-300 rounded-lg p-10 text-center hover:bg-gray-50 transition-colors cursor-pointer"
                        onDragOver={(e) => e.preventDefault()}
                        onDrop={(e) => {
                          e.preventDefault();
                          const f = e.dataTransfer.files?.[0];
                          if (f) handleZipSelect(f);
                        }}
                        onClick={() => document.getElementById("zip-upload")?.click()}
                      >
                        <div className="flex flex-col items-center gap-2">
                          {zipValidating ? (
                            <Loader2 className="h-8 w-8 text-gray-400 animate-spin" />
                          ) : (
                            <Archive className="h-8 w-8 text-gray-400" />
                          )}
                          <span className="text-sm font-medium text-gray-600">
                            {zipValidating ? "Validating zip..." : "Drag and drop a .zip file"}
                          </span>
                          <span className="text-xs text-gray-400">or click to browse (max 200MB)</span>
                        </div>
                        <Input
                          id="zip-upload"
                          type="file"
                          className="hidden"
                          accept=".zip,application/zip"
                          onChange={(e) => {
                            const f = e.target.files?.[0];
                            if (f) handleZipSelect(f);
                          }}
                        />
                      </div>
                    ) : (
                      <div className="space-y-3">
                        <div className="flex items-center justify-between border rounded-lg p-3 bg-gray-50">
                          <div className="flex items-center gap-2">
                            <Archive className="h-5 w-5 text-primary" />
                            <span className="text-sm font-medium">{zipFile.name}</span>
                            <span className="text-xs text-gray-500">{formatSizeMb(zipFile)}</span>
                          </div>
                          <button
                            type="button"
                            className="text-xs text-gray-400 hover:text-gray-600"
                            onClick={() => { setZipFile(null); setZipPairs([]); setZipStatus({ type: null, message: "" }); }}
                          >
                            Remove
                          </button>
                        </div>

                        {zipPairs.length > 0 && (
                          <div className="border rounded-lg overflow-hidden">
                            <div className="bg-gray-50 px-3 py-2 text-xs font-semibold text-gray-600 border-b">
                              {zipPairs.filter(p => !p.error).length} valid pair(s) · {zipPairs.filter(p => p.error).length} with errors
                            </div>
                            <div className="max-h-48 overflow-y-auto divide-y divide-gray-100">
                              {zipPairs.map((pair, i) => (
                                <div key={i} className={`flex items-center justify-between px-3 py-2 text-xs ${pair.error ? "bg-red-50" : ""}`}>
                                  <div className="flex items-center gap-2 min-w-0">
                                    <FileText className={`h-3.5 w-3.5 flex-shrink-0 ${pair.error ? "text-red-400" : "text-primary"}`} />
                                    <span className="truncate font-mono">{pair.primaryFile.name}</span>
                                  </div>
                                  {pair.error ? (
                                    <span className="text-red-600 ml-2 flex-shrink-0">{pair.error}</span>
                                  ) : (
                                    <span className="text-green-600 ml-2 flex-shrink-0">✓ paired</span>
                                  )}
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    )}

                    {zipStatus.message && (
                      <div className={`text-sm p-2 rounded ${zipStatus.type === "success" ? "bg-green-100 text-green-700" : "bg-red-100 text-red-700"}`}>
                        {zipStatus.message}
                      </div>
                    )}
                  </div>
                  )}

                  <DialogFooter>
                    <Button variant="outline" onClick={resetUploadDialog} disabled={uploading || zipUploading}>
                      Cancel
                    </Button>
                    {uploadTab === "single" ? (
                      <Button
                        className="bg-primary hover:bg-primary/90"
                        onClick={handleUpload}
                        disabled={!primaryFile || !metadataFile || uploading}
                      >
                        {uploading ? (
                          <>
                            <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
                            Uploading...
                          </>
                        ) : (
                          "Upload & Stage"
                        )}
                      </Button>
                    ) : (
                      <Button
                        className="bg-primary hover:bg-primary/90"
                        onClick={handleZipUpload}
                        disabled={!zipFile || zipPairs.filter(p => !p.error).length === 0 || zipUploading || zipValidating}
                      >
                        {zipUploading ? (
                          <>
                            <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
                            Uploading...
                          </>
                        ) : (
                          `Upload & Stage ${zipPairs.filter(p => !p.error).length} pair(s)`
                        )}
                      </Button>
                    )}
                  </DialogFooter>
                </DialogContent>
              </Dialog>
            </div>
          </div>

          {syncStatus.message && (
            <div
              className={`text-sm p-3 rounded ${
                syncStatus.type === "success"
                  ? "bg-green-100 text-green-700"
                  : "bg-red-100 text-red-700"
              }`}
            >
              {syncStatus.message}
            </div>
          )}
        </div>

        <Card className="border-gray-200 shadow-sm">
          <CardHeader className="pb-3">
            <div className="relative">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-gray-500" />
              <Input
                placeholder="Search your Sources"
                className="pl-9 max-w-md bg-gray-50 border-gray-200"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
            </div>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader className="bg-gray-50">
                <TableRow>
                  <TableHead className="w-[45%]">Name</TableHead>
                  <TableHead className="w-[10%]">Type</TableHead>
                  <TableHead className="w-[12%]">Status</TableHead>
                  <TableHead className="w-[16%]">Uploaded</TableHead>
                  <TableHead className="w-[16%]">Completed</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {loading ? (
                  <TableRow>
                    <TableCell colSpan={5} className="py-10">
                      <div className="flex items-center justify-center gap-2 text-gray-500">
                        <Loader2 className="h-4 w-4 animate-spin" />
                        <span>Loading data sources...</span>
                      </div>
                    </TableCell>
                  </TableRow>
                ) : pagedDataSources.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={5} className="text-center py-10 text-gray-500">
                      No data sources found.
                    </TableCell>
                  </TableRow>
                ) : (
                  pagedDataSources.map((ds) => {
                    const run = latestRunBySourceId.get(ds.id);
                    const status = run?.status ?? "no_runs";
                    const isExpandable =
                      ds.type === "website" ||
                      ((ds.type === "csv" || ds.type === "markdown") && !!jsonByCsvName.get(ds.name));
                    const isOpen = !!expanded[ds.id];

                    return (
                      <>
                        <TableRow key={ds.id} className={isOpen ? "bg-gray-50/50" : ""}>
                          <TableCell className="align-top">
                            <div className="flex items-start gap-2">
                              {isExpandable ? (
                                <button
                                  type="button"
                                  className="mt-0.5 text-xs rounded border border-gray-200 px-2 py-1 text-gray-600 hover:bg-gray-50"
                                  onClick={() =>
                                    setExpanded((prev) => ({ ...prev, [ds.id]: !prev[ds.id] }))
                                  }
                                  title={isOpen ? "Hide details" : "Show details"}
                                >
                                  {isOpen ? "Hide" : "Details"}
                                </button>
                              ) : (
                                <span className="mt-0.5 text-xs rounded border border-gray-200 px-2 py-1 text-gray-400">
                                  —
                                </span>
                              )}

                              <div className="min-w-0">
                                <div className="font-medium text-gray-900 break-all">
                                  {ds.name}
                                </div>
                              </div>
                            </div>
                          </TableCell>

                          <TableCell className="align-top">
                            <Badge variant="secondary">{typeLabel(ds.type)}</Badge>
                          </TableCell>

                          <TableCell className="align-top">
                            {statusBadge(status, Boolean(run?.error_message))}
                          </TableCell>

                          <TableCell className="align-top text-sm text-gray-700">
                            {formatDateTime(ds.created_at)}
                          </TableCell>

                          <TableCell className="align-top text-sm text-gray-700">
                            {formatDateTime(run?.completed_at ?? null)}
                          </TableCell>
                        </TableRow>

                        {isOpen ? (
                          <TableRow key={`${ds.id}-sub`}>
                            <TableCell colSpan={5} className="bg-gray-50/70">
                              {ds.type === "website" ? (
                                <div className="space-y-3">
                                  <div className="text-sm font-medium text-gray-800">
                                    Crawl rules
                                  </div>

                                  {(ds.include_patterns?.length ?? 0) > 0 ? (
                                    <div>
                                      <div className="text-xs font-semibold text-gray-600 mb-1">
                                        Include patterns
                                      </div>
                                      <div className="text-xs font-mono bg-white border border-gray-200 rounded p-3 overflow-auto">
                                        {(ds.include_patterns ?? []).map((p, i) => (
                                          <div key={i} className="break-all">
                                            {p}
                                          </div>
                                        ))}
                                      </div>
                                    </div>
                                  ) : (
                                    <div className="text-xs text-gray-500">No include patterns.</div>
                                  )}

                                  {(ds.exclude_patterns?.length ?? 0) > 0 ? (
                                    <div>
                                      <div className="text-xs font-semibold text-gray-600 mb-1">
                                        Exclude patterns
                                      </div>
                                      <div className="text-xs font-mono bg-white border border-gray-200 rounded p-3 overflow-auto">
                                        {(ds.exclude_patterns ?? []).map((p, i) => (
                                          <div key={i} className="break-all">
                                            {p}
                                          </div>
                                        ))}
                                      </div>
                                    </div>
                                  ) : (
                                    <div className="text-xs text-gray-500">No exclude patterns.</div>
                                  )}

                                  {run?.error_message ? (
                                    <div className="text-xs text-red-600 bg-red-50 border border-red-200 rounded p-3">
                                      {run.error_message}
                                    </div>
                                  ) : null}
                                </div>
                              ) : ds.type === "csv" || ds.type === "markdown" ? (
                                (() => {
                                  const json = jsonByCsvName.get(ds.name);
                                  const jsonRun = json ? latestRunBySourceId.get(json.id) : undefined;
                                  const jsonStatus = jsonRun?.status ?? "no_runs";

                                  return (
                                    <div className="space-y-5">
                                      <div className="space-y-2">
                                        <div className="text-sm font-medium text-gray-800">
                                          Metadata JSON file
                                        </div>

                                        {json ? (
                                          <div className="rounded-lg border border-gray-200 bg-white overflow-hidden">
                                            <div className="grid grid-cols-[45%_10%_12%_16%_17%] gap-0 text-sm items-start">
                                              <div className="px-3 py-3 border-r border-gray-100 min-w-0">
                                                <div className="font-medium text-gray-900 break-all">
                                                  {json.name}
                                                </div>
                                              </div>

                                              <div className="px-3 py-3 border-r border-gray-100">
                                                <Badge variant="secondary">{typeLabel(json.type)}</Badge>
                                              </div>

                                              <div className="px-3 py-3 border-r border-gray-100">
                                                {statusBadge(jsonStatus, Boolean(jsonRun?.error_message))}
                                              </div>

                                              <div className="px-3 py-3 border-r border-gray-100 text-xs text-gray-700">
                                                {formatDateTime(json.created_at)}
                                              </div>

                                              <div className="px-3 py-3 border-r border-gray-100 text-xs text-gray-700">
                                                {formatDateTime(jsonRun?.completed_at ?? null)}
                                              </div>
                                            </div>
                                          </div>
                                        ) : (
                                          <div className="text-xs text-gray-500">
                                            No metadata JSON found for this CSV or Markdown.
                                          </div>
                                        )}
                                      </div>

                                      {/* Failure reasons reported by the Bedrock ingestion job */}
                                      {run?.error_message || jsonRun?.error_message ? (
                                        <div className="space-y-2">
                                          <div className="text-sm font-medium text-gray-800">
                                            Ingestion errors
                                          </div>
                                          {run?.error_message ? (
                                            <div className="text-xs text-red-600 bg-red-50 border border-red-200 rounded p-3 break-words">
                                              {run.error_message}
                                            </div>
                                          ) : null}
                                          {jsonRun?.error_message &&
                                          jsonRun.error_message !== run?.error_message ? (
                                            <div className="text-xs text-red-600 bg-red-50 border border-red-200 rounded p-3 break-words">
                                              {jsonRun.error_message}
                                            </div>
                                          ) : null}
                                        </div>
                                      ) : null}
                                    </div>
                                  );
                                })()
                              ) : (
                                <div className="text-xs text-gray-500">No details.</div>
                              )}
                            </TableCell>
                          </TableRow>
                        ) : null}
                      </>
                    );
                  })
                )}
              </TableBody>
            </Table>
          </CardContent>

          {!loading && filteredDataSources.length > 0 && (
            <div className="flex items-center justify-between px-4 py-3 border-t border-gray-200">
              <div className="text-sm text-gray-600">
                Showing <span className="font-medium">{Math.min(startIdx + 1, filteredDataSources.length)}</span> to{" "}
                <span className="font-medium">{Math.min(startIdx + PAGE_SIZE, filteredDataSources.length)}</span> of{" "}
                <span className="font-medium">{filteredDataSources.length}</span>
              </div>

              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  disabled={currentPage === 1}
                >
                  Prev
                </Button>

                <div className="text-sm text-gray-700">
                  Page <span className="font-medium">{currentPage}</span> of{" "}
                  <span className="font-medium">{totalPages}</span>
                </div>

                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  disabled={currentPage === totalPages}
                >
                  Next
                </Button>
              </div>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}