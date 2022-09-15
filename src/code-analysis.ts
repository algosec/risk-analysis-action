import "dotenv/config";
import { IVersionControl } from "./vcs/vcs.model";
import { RiskAnalysisFile, RiskAnalysisResult } from "./common/risk.model";
import { writeFileSync } from "fs";

export class AshCodeAnalysis {
  debugMode;
  apiUrl;
  tenantId;
  clientId;
  clientSecret;
  loginAPI;
  actionUuid;
  jwt: string;
  gcpCredsJson: string

  constructor(public vcs: IVersionControl) {}

  async init(): Promise<boolean> {
    this.setSecrets();
    this.jwt = await this.auth(
      this.tenantId,
      this.clientId,
      this.clientSecret,
      this.loginAPI
    );
    if (!this.jwt || this.jwt == "") {
      this.vcs.logger.exit(
        "Not Authenticated"
      );
      return false;
    }
    this.vcs.steps.auth = { exitCode: 0, stdout: this.jwt, stderr: "" };
    return true;
  }

  setSecrets(): void {
    const inputs = this.vcs.getInputs();
    this.debugMode = inputs?.ALGOSEC_DEBUG == "true";
    this.apiUrl = this.vcs.cfApiUrl
    this.loginAPI = inputs?.CF_LOGIN_API ?? "https://dev.app.algosec.com/api/algosaas/auth/v1/access-keys/login";
    this.tenantId = inputs?.CF_TENANT_ID;
    this.clientId = inputs?.CF_CLIENT_ID;
    this.clientSecret = inputs?.CF_CLIENT_SECRET;
    this.gcpCredsJson = inputs?.GOOGLE_CREDENTIALS  ?? ""
  }

  async auth(
    tenantId: string,
    clientID: string,
    clientSecret: string,
    loginAPI: string
  ): Promise<string> {
    const payload = {
      tenantId,
      clientId: clientID,
      clientSecret,
    };

    const headers = {
      "Content-Type": "application/json",
    };
    try {
      const res = await this.vcs.http.post(
        loginAPI,
        JSON.stringify(payload),
        headers
      );

      const response_code = res.message.statusCode;
      const data = JSON.parse(await res.readBody());
      // this.gcpCredsJson ? await this.createGcpCredentials(this.gcpCredsJson) : null
      if (response_code >= 200 && response_code <= 300) {
        this.vcs.logger.info(
          "Passed authentication vs CF's login. new token has been generated."
        );
        return data?.access_token;
      } else {
        this.vcs.logger.exit(
          `Failed to generate token.\n Error code ${response_code}, msg: ${JSON.stringify(
            data, null, "\t"
          )}`
        );
      }
    } catch (error: any) {
      this.vcs.logger.exit(
        `Failed to generate token. Error msg: ${error.toString()}`
      );
    }
    return "";
  }

  async createGcpCredentials(gcpCredsString: string){
    // const gcpCreds = JSON.parse(gcpCredsString)
    const credentialsFilePath =`${this.vcs.workDir}/gcp_auth.json`
    try {
      writeFileSync(credentialsFilePath, gcpCredsString)
      process.env.GOOGLE_APPLICATION_CREDENTIALS = credentialsFilePath
    } catch(e){
      this.vcs.logger.error("Creating GCP Credentials failed: "+e)
    }

  }

  async triggerCodeAnalysis(filesToUpload: RiskAnalysisFile[]): Promise<void> {
    try {
      const fileUploadPromises: Array<Promise<boolean>> = [];
      filesToUpload.forEach((file) =>
        fileUploadPromises.push(this.uploadFile(file))
      );
  
      const responses = await Promise.all(fileUploadPromises);
  
      if (responses.filter(response => response).length == 0) {
        this.vcs.logger.exit(
          "No files were uploaded, please check logs"
        );
      } else if (responses.some(response => !response)) {
        this.vcs.logger.error(
          "Some files failed to upload, please check logs"
        );
      } else {
        this.vcs.logger.info(
          "File/s were uploaded successfully"
        );
      }
    } catch(e){
      this.vcs.steps.upload = {exitCode: 0, stdout: '', stderr: "Upload Failure: " + e}
      this.vcs.logger.error(
        "Some files failed to upload, please check logs"
      );
      
    }

  }

  async uploadFile(file: RiskAnalysisFile): Promise<boolean> {
    let res = false;
    try {
      if (file?.output?.plan != '') {
        const ans = await this.vcs.uploadAnalysisFile(file, this.jwt);
        if (ans) {
          res = true;
        }
      } else {
        this.vcs.logger.info(`No plan was created for: ${file.folder}, please check terraform logs`)
      }
    } catch (e) {
      this.vcs.logger.error(`File upload for: ${file.folder} failed due to errors:\n ${e}`)
      res = false;
    }
    return res;
  }

  async analyze(filesToUpload: RiskAnalysisFile[]): Promise<Array<RiskAnalysisResult | null>> {
    let analysisResult: Array<RiskAnalysisResult | null> = [];
    try {
      await this.triggerCodeAnalysis(filesToUpload);
      const codeAnalysisPromises: Array<Promise<RiskAnalysisResult | null>> = [];
      filesToUpload
        .filter((file) => file?.output?.plan != '')
        .forEach((file) =>
          codeAnalysisPromises.push(this.pollCodeAnalysisResponse(file))
        );
      analysisResult = await Promise.all(codeAnalysisPromises);
      if (!analysisResult || analysisResult?.length == 0) {
        this.vcs.steps.analysis = {exitCode: 0, stdout: '', stderr: "Analysis failed, please contact support."}
        this.vcs.logger.exit("Code Analysis failed");
        analysisResult = []
      }
      this.vcs.logger.debug(
        `Risk analysis result:\n${JSON.stringify(analysisResult, null, "\t")}\n`, true
      );
    } catch(e){
      this.vcs.steps.analysis = {exitCode: 0, stdout: '', stderr: "Analysis failed, please contact support.\n" + e}
      this.vcs.logger.exit(`Code Analysis failed due to errors: ${e}`);
      analysisResult = []
    }
   
    return analysisResult;
  }

  async pollCodeAnalysisResponse(
    file: RiskAnalysisFile
  ): Promise<RiskAnalysisResult | null> {
    let analysisResult = await this.checkCodeAnalysisResponse(file);
    this.vcs.logger.info(
      `Waiting for risk analysis response for folder: ${file.folder}`
    );
    for (let i = 0; i < 60; i++) {
      await this.wait(5000);
      analysisResult = await this.checkCodeAnalysisResponse(file);
      if (analysisResult?.additions) {
        analysisResult.folder = file?.folder;
        this.vcs.logger.debug(
          "Response:\n" + JSON.stringify(analysisResult) + "\n", true
        );
        break;
      } else if (analysisResult?.error) {
        this.vcs.logger.error(
          "Poll Request failed for folder: " + file?.folder + analysisResult?.error
        );
        break;
      }
    }
    if (!analysisResult){
      this.vcs.logger.error(
        "Poll Request has timed out for folder: "+ file?.folder
      );
    }
    return analysisResult;
  }

  async wait(ms = 1000): Promise<void> {
    return await new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  }

  async checkCodeAnalysisResponse(
    file: RiskAnalysisFile
  ): Promise<RiskAnalysisResult | null> {
    const pollUrl = `${this.apiUrl}/analysis_result?customer=${this.vcs.repo.owner}&action_id=${file.uuid}`;
    const response = await this.vcs.http.get(pollUrl, {
      Authorization: "Bearer " + this.jwt,
    });
    if (response?.message?.statusCode == 200) {
      const body = await response.readBody();
      const message = body && body != "" ? JSON.parse(body) : null;
      if (message?.message_found) {
        const result = message?.result ? JSON.parse(message?.result) : null;
        return result;
      } else {
        return null;
      }
    } else {
      return {
        error: response.message.statusMessage,
        proceeded_file: "",
        additions: { analysis_result: [], analysis_state: false },
        success: false,
      };
    }
  }
}
