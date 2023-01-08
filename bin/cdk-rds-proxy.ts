#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { CdkRdsProxyStack } from '../lib/cdk-rds-proxy-stack';
import { Context } from '../lib/common/context'

const app = new cdk.App();
new CdkRdsProxyStack(app, `${Context.ID_PREFIX}-CdkRdsProxyStack`, {
    env: {account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION},
});